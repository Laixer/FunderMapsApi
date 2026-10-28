import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dossier, staffCapacity } from "../db/schema/dataops.ts";
import { organizationUser, user as appUser } from "../db/schema/application.ts";
import { env } from "../config.ts";
import { ConflictError } from "./errors.ts";
import { addEntry } from "./dossier-entries.ts";
import { personName } from "./person-name.ts";
import { fileCount, melderRepliedLast, onDesk, readKind } from "./queue-sql.ts";
import { BUCKET_CHANNELS, planDispatch, type Bucket, type Candidate, type Holding, type Mode, type Person } from "./dispatch.ts";

// The dispatcher against the database (#277): load who takes work, what they
// hold and what is open, ask lib/dispatch.ts what to do, and apply it. Called
// by POST /api/dataops/dispatch (the Windmill schedule, as the Fundie user)
// and POST /api/management/capacity/dispatch (an admin's preview or run).

const rows = <T>(r: unknown) => r as T[];

/** The open dossiers the new-meldingen bucket hands out: a document attached, the melder not waiting on an answer. */
export const newBucket = (): SQL => and(
  inArray(dossier.channel, [...BUCKET_CHANNELS.new] as ("upload" | "email")[]),
  sql`${fileCount} > 0`,
  sql`not ${melderRepliedLast}`,
)!;
/** Older research: nalezingen and the archive drop. */
export const researchBucket = (): SQL => inArray(dossier.channel, [...BUCKET_CHANNELS.research] as ("audit" | "bulk_drop")[]);
/** Not invoerder work: a question without a document, or the melder had the last word. */
export const questionBucket = (): SQL => sql`(${fileCount} = 0 or ${melderRepliedLast})`;

const bucketOf = (channel: string): Bucket | null =>
  (BUCKET_CHANNELS.new as readonly string[]).includes(channel) ? "new"
    : (BUCKET_CHANNELS.research as readonly string[]).includes(channel) ? "research" : null;

/**
 * When the holder last did something on the dossier: the assignment itself,
 * a timeline entry of theirs (not a hand-over), or a value they judged.
 */
const lastTouchedAt = sql<string | null>`greatest(
  ${dossier.assignedAt},
  (select max(e.at) from dataops.dossier_entry e
    where e.dossier_id = "dataops"."dossier"."id" and e.actor = "dataops"."dossier"."assigned_to"::text
      and e.body -> 'assignment' is null),
  (select max(v.decided_at) from dataops.verdict v
    join dataops.extraction_field f on f.id = v.extraction_field_id
    join dataops.extraction x on x.id = f.extraction_id
    join dataops.artifact a on a.id = x.artifact_id
    where a.dossier_id = "dataops"."dossier"."id" and v.decided_by = "dataops"."dossier"."assigned_to"))`;

interface Named extends Person { name: string }

/** The people in the capacity table who are still staff (members of the platform organisation). */
export async function loadPeople(): Promise<Named[]> {
  const r = await db
    .select({
      userId: staffCapacity.userId,
      hoursPerWeek: staffCapacity.hoursPerWeek,
      workingDays: staffCapacity.workingDays,
      preferredKinds: staffCapacity.preferredKinds,
      active: staffCapacity.active,
      name: appUser.name,
      givenName: appUser.givenName,
      lastName: appUser.lastName,
      email: appUser.email,
    })
    .from(staffCapacity)
    .innerJoin(organizationUser, and(eq(organizationUser.userId, staffCapacity.userId), eq(organizationUser.organizationId, env.PLATFORM_ORGANIZATION_ID)))
    .innerJoin(appUser, eq(appUser.id, staffCapacity.userId))
    .orderBy(asc(staffCapacity.userId));
  return r.map((p) => ({
    userId: p.userId,
    hoursPerWeek: Number(p.hoursPerWeek),
    workingDays: p.workingDays,
    preferredKinds: p.preferredKinds,
    active: p.active,
    name: personName(p),
  }));
}

async function loadHoldings(userIds: string[]): Promise<Holding[]> {
  if (userIds.length === 0) return [];
  const r = await db
    .select({ id: dossier.id, userId: dossier.assignedTo, channel: dossier.channel, receivedAt: dossier.receivedAt, kind: readKind, lastTouchedAt })
    .from(dossier)
    .where(and(onDesk(), inArray(dossier.assignedTo, userIds)));
  return r.map((h) => ({
    dossierId: h.id,
    userId: h.userId!,
    bucket: bucketOf(h.channel),
    kind: h.kind,
    receivedAt: h.receivedAt,
    // Never touched and no assignment time (an old hand-over): not idle, leave it.
    lastTouchedAt: h.lastTouchedAt ? new Date(h.lastTouchedAt) : new Date(),
  }));
}

async function loadCandidates(bucket: Bucket): Promise<Candidate[]> {
  const r = await db
    .select({ id: dossier.id, receivedAt: dossier.receivedAt, kind: readKind })
    .from(dossier)
    .where(and(onDesk(), isNull(dossier.assignedTo), bucket === "new" ? newBucket() : researchBucket()))
    .orderBy(asc(dossier.receivedAt), asc(dossier.id));
  return r.map((c) => ({ dossierId: c.id, bucket, kind: c.kind, receivedAt: c.receivedAt }));
}

export interface DispatchResult {
  dryRun: boolean;
  mode: Mode;
  at: string;
  release: { dossierId: number; userId: string; person: string; idleWorkingDays: number }[];
  assign: { dossierId: number; userId: string; person: string; bucket: Bucket; preferred: boolean }[];
  unplaced: { new: number; research: number };
  people: { userId: string; person: string; target: number; held: number; working: boolean }[];
  /** Planned changes that did not apply because the dossier moved meanwhile (closed, or assigned by hand). */
  skipped: number;
}

/**
 * Plan and, unless dryRun, apply. Applying runs in one transaction behind an
 * advisory lock, so two runs (the schedule and an admin's click) never
 * interleave; each update re-checks that the dossier is still open and still
 * held as planned, so a dossier closed or handed over by hand meanwhile is
 * skipped, never overwritten. Every change is a line on the dossier's
 * timeline, like a hand-over by a person.
 */
export async function runDispatch(opts: { mode: Mode; dryRun: boolean; actorId: string; now?: Date }): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const people = await loadPeople();
  const names = new Map(people.map((p) => [p.userId, p.name]));
  const [holdings, fresh, research] = await Promise.all([
    loadHoldings(people.map((p) => p.userId)),
    opts.mode === "drip" ? Promise.resolve([]) : loadCandidates("new"),
    opts.mode === "new" ? Promise.resolve([]) : loadCandidates("research"),
  ]);
  const plan = planDispatch({ now, mode: opts.mode, people, holdings, candidates: [...fresh, ...research] });
  const name = (id: string) => names.get(id) ?? "onbekend";

  let skipped = 0;
  const release = plan.release.map((r) => ({ ...r, person: name(r.userId) }));
  const assign = plan.assign.map((a) => ({ ...a, person: name(a.userId) }));
  if (!opts.dryRun && (release.length || assign.length)) {
    await db.transaction(async (tx) => {
      const lock = rows<{ locked: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext('dataops.dispatch')) as locked`));
      if (!lock[0]?.locked) throw new ConflictError("a dispatch is already running");
      for (const r of release) {
        const done = await tx.update(dossier)
          .set({ assignedTo: null, assignedAt: null, updatedAt: now })
          .where(and(eq(dossier.id, r.dossierId), eq(dossier.assignedTo, r.userId), onDesk()))
          .returning({ id: dossier.id });
        if (!done.length) { skipped++; continue; }
        await addEntry({
          dossierId: r.dossierId, kind: "status", actorKind: "system", actor: opts.actorId,
          text: `Terug in de algemene wachtrij: ${r.idleWorkingDays} werkdagen niet aangeraakt door ${r.person} (automatische verdeling)`,
          body: { assignment: { to: null, from: r.userId, by: "dispatch", reason: "stale", idleWorkingDays: r.idleWorkingDays } },
          visibleToMelder: false,
        }, tx);
      }
      for (const a of assign) {
        const done = await tx.update(dossier)
          .set({ assignedTo: a.userId, assignedAt: now, updatedAt: now })
          .where(and(eq(dossier.id, a.dossierId), isNull(dossier.assignedTo), onDesk()))
          .returning({ id: dossier.id });
        if (!done.length) { skipped++; continue; }
        await addEntry({
          dossierId: a.dossierId, kind: "status", actorKind: "system", actor: opts.actorId,
          text: `Toegewezen aan ${a.person} (automatische verdeling)`,
          body: { assignment: { to: a.userId, from: null, by: "dispatch", bucket: a.bucket } },
          visibleToMelder: false,
        }, tx);
      }
    });
  }

  return {
    dryRun: opts.dryRun,
    mode: opts.mode,
    at: now.toISOString(),
    release,
    assign,
    unplaced: plan.unplaced,
    people: plan.people.map((p) => ({ ...p, person: name(p.userId) })),
    skipped,
  };
}

/** The latest automatic assignment or release, i.e. when the dispatcher last changed something. */
export async function lastDispatchAt(): Promise<string | null> {
  const r = rows<{ at: string | null }>(await db.execute(sql`
    select max(at)::text as at from dataops.dossier_entry where kind = 'status' and body -> 'assignment' ->> 'by' = 'dispatch'
  `));
  return r[0]?.at ?? null;
}

/** Open dossiers per bucket that nobody holds, and the open questions (which nobody is dispatched). */
export async function bucketSizes(): Promise<{ new: number; research: number; questions: number }> {
  const count = async (where: SQL) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(dossier).where(where);
    return r?.n ?? 0;
  };
  const [fresh, research, questions] = await Promise.all([
    count(and(onDesk(), isNull(dossier.assignedTo), newBucket())!),
    count(and(onDesk(), isNull(dossier.assignedTo), researchBucket())!),
    count(and(onDesk(), inArray(dossier.channel, ["upload", "email"]), questionBucket())!),
  ]);
  return { new: fresh, research, questions };
}

/** Per staff member: open dossiers held per bucket, closed this (Amsterdam) week, and the oldest one held. */
export async function holdingsPerPerson(): Promise<Map<string, { new: number; research: number; other: number; doneThisWeek: number; oldestAssignedAt: string | null }>> {
  const [open, done] = await Promise.all([
    db.select({ userId: dossier.assignedTo, channel: dossier.channel, n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${dossier.assignedAt})::text` })
      .from(dossier).where(and(onDesk(), isNotNull(dossier.assignedTo))).groupBy(dossier.assignedTo, dossier.channel),
    db.select({ userId: dossier.assignedTo, n: sql<number>`count(*)::int` })
      .from(dossier)
      .where(and(isNotNull(dossier.assignedTo), sql`${dossier.outcomeAt} >= (date_trunc('week', now() at time zone 'Europe/Amsterdam') at time zone 'Europe/Amsterdam')`))
      .groupBy(dossier.assignedTo),
  ]);
  const out = new Map<string, { new: number; research: number; other: number; doneThisWeek: number; oldestAssignedAt: string | null }>();
  const get = (id: string) => {
    let v = out.get(id);
    if (!v) out.set(id, (v = { new: 0, research: 0, other: 0, doneThisWeek: 0, oldestAssignedAt: null }));
    return v;
  };
  for (const r of open) {
    const v = get(r.userId!);
    v[bucketOf(r.channel) ?? "other"] += r.n;
    if (r.oldest && (!v.oldestAssignedAt || r.oldest < v.oldestAssignedAt)) v.oldestAssignedAt = r.oldest;
  }
  for (const r of done) get(r.userId!).doneThisWeek = r.n;
  return out;
}
