// The review-queue dispatcher's rules (#277), without the database, so every
// rule can be tested on its own. The route (routes/dataops-dispatch.ts) loads
// the people, what they hold and the open dossiers, asks planDispatch what to
// do, and applies that in one transaction.
//
// Work is pushed to people instead of everyone filtering one shared queue.
// Two buckets, two rules (Don, 2026-10-22, on the issue):
//   new       new meldingen (channel upload/email, a document attached, the
//             melder not waiting on an answer): as fast as possible -- each
//             gets an assignee on the run after it arrives, whoever has the
//             most room among the people working today.
//   research  older research (channel audit = nalezingen, bulk_drop = the
//             archive drop): drip-fed -- each person's holding is topped up to
//             a day's worth, never the whole backlog at once.
// Questions and replies (no document, or the melder had the last word) are
// not invoerder work and are never assigned here.
//
// Who takes work and how much is dataops.staff_capacity (Worker migration
// 20261028_001): hours a week, the weekdays they work, preferred document
// kinds. A preference weighs the choice; it never excludes anyone.

export type Bucket = "new" | "research";
export type Mode = "new" | "drip" | "all";

/** Channels per bucket. Everything else (invoer_app, api) stays with the work packages. */
export const BUCKET_CHANNELS: Record<Bucket, readonly string[]> = {
  new: ["upload", "email"],
  research: ["audit", "bulk_drop"],
};

/** A day's worth: open dossiers a person holds per hour of their working day. */
export const ITEMS_PER_HOUR = 1;
/** Working days (the person's own) without any action before an assignment goes back to the pool. */
export const STALE_WORKING_DAYS = 5;

const TZ = "Europe/Amsterdam";
const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" });

/** The Amsterdam calendar day of an instant, as YYYY-MM-DD. */
export function amsterdamDay(at: Date): string {
  return dayFormat.format(at);
}

/** The ISO weekday (1 = Monday … 7 = Sunday) of an instant, in Amsterdam. */
export function amsterdamWeekday(at: Date): number {
  return WEEKDAY[weekdayFormat.format(at)]!;
}

/**
 * How many of a person's working days passed since `from`: the Amsterdam
 * calendar days after the day of `from`, up to and including the day of `now`,
 * whose weekday the person works. Touched today = 0; assigned on a Friday and
 * untouched, a Monday-to-Friday person has 1 on Monday.
 */
export function workingDaysSince(from: Date, now: Date, workingDays: readonly number[]): number {
  const start = amsterdamDay(from);
  const end = amsterdamDay(now);
  if (end <= start) return 0;
  let n = 0;
  // Walk calendar days at noon UTC: always the same Amsterdam date, DST or not.
  const day = new Date(`${start}T12:00:00Z`);
  for (;;) {
    day.setUTCDate(day.getUTCDate() + 1);
    const d = day.toISOString().slice(0, 10);
    if (d > end) break;
    if (workingDays.includes(amsterdamWeekday(day))) n++;
  }
  return n;
}

/** Open dossiers a person holds on a working day: their hours a day times ITEMS_PER_HOUR, at least 1 if they work at all. */
export function dailyTarget(hoursPerWeek: number, workingDays: readonly number[], itemsPerHour = ITEMS_PER_HOUR): number {
  if (hoursPerWeek <= 0 || workingDays.length === 0) return 0;
  return Math.max(1, Math.round((hoursPerWeek / workingDays.length) * itemsPerHour));
}

export interface Person {
  userId: string;
  hoursPerWeek: number;
  workingDays: number[];
  preferredKinds: string[];
  active: boolean;
}

/** An open dossier someone holds. `bucket` null = a channel the dispatcher does not hand out. */
export interface Holding {
  dossierId: number;
  userId: string;
  bucket: Bucket | null;
  /** The later of the assignment and the holder's last action on the dossier. */
  lastTouchedAt: Date;
  kind: string | null;
  receivedAt: Date;
}

/** An open, unassigned dossier the dispatcher may hand out. */
export interface Candidate {
  dossierId: number;
  bucket: Bucket;
  /** The document kind as the reader read it; null until read. */
  kind: string | null;
  receivedAt: Date;
}

export interface Plan {
  release: { dossierId: number; userId: string; idleWorkingDays: number }[];
  assign: { dossierId: number; userId: string; bucket: Bucket; preferred: boolean }[];
  /** New meldingen nobody could take (nobody works today), and the research left in the pool. */
  unplaced: { new: number; research: number };
  people: { userId: string; target: number; held: number; working: boolean }[];
}

export interface PlanInput {
  now: Date;
  mode: Mode;
  people: Person[];
  holdings: Holding[];
  candidates: Candidate[];
  itemsPerHour?: number;
  staleWorkingDays?: number;
}

/**
 * What the dispatcher would do, in order:
 *  1. release   (every mode) an assignment of a person in the capacity table
 *               that saw no action of theirs for STALE_WORKING_DAYS of their
 *               own working days goes back to the pool -- absence, holiday.
 *               Manual hand-overs to people outside the table are left alone.
 *  2. new       each new melding, oldest first, to the person working today
 *               with the most room (preferring the kind among those with
 *               room); with nobody having room, still to the least loaded:
 *               a melder waits on it. Nobody working today = unplaced.
 *  3. drip      each person working today is topped up to their day's
 *               target with research, preferred kinds first, oldest first.
 * A dossier released in this run never goes back to the same person in it.
 * Deterministic: the same input gives the same plan.
 */
export function planDispatch(input: PlanInput): Plan {
  const { now, mode } = input;
  const itemsPerHour = input.itemsPerHour ?? ITEMS_PER_HOUR;
  const staleDays = input.staleWorkingDays ?? STALE_WORKING_DAYS;
  const weekday = amsterdamWeekday(now);

  const byId = new Map(input.people.map((p) => [p.userId, p]));
  const held = new Map<string, number>(input.people.map((p) => [p.userId, 0]));
  const release: Plan["release"] = [];
  const releasedFrom = new Map<number, string>();
  const candidates = [...input.candidates];

  for (const h of [...input.holdings].sort((a, b) => a.dossierId - b.dossierId)) {
    const person = byId.get(h.userId);
    if (!person) continue;
    const idle = workingDaysSince(h.lastTouchedAt, now, person.workingDays);
    if (idle >= staleDays) {
      release.push({ dossierId: h.dossierId, userId: h.userId, idleWorkingDays: idle });
      releasedFrom.set(h.dossierId, h.userId);
      // Open and unassigned once released: a candidate again in this same run.
      if (h.bucket) candidates.push({ dossierId: h.dossierId, bucket: h.bucket, kind: h.kind, receivedAt: h.receivedAt });
    } else {
      held.set(h.userId, (held.get(h.userId) ?? 0) + 1);
    }
  }

  const target = (p: Person) => dailyTarget(p.hoursPerWeek, p.workingDays, itemsPerHour);
  const room = (p: Person) => target(p) - (held.get(p.userId) ?? 0);
  const working = input.people
    .filter((p) => p.active && p.workingDays.includes(weekday) && target(p) > 0)
    .sort((a, b) => a.userId.localeCompare(b.userId));
  const oldestFirst = (a: Candidate, b: Candidate) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.dossierId - b.dossierId;

  const assign: Plan["assign"] = [];
  let unplacedNew = 0;
  if (mode === "new" || mode === "all") {
    for (const c of candidates.filter((x) => x.bucket === "new").sort(oldestFirst)) {
      const eligible = working.filter((p) => releasedFrom.get(c.dossierId) !== p.userId);
      if (eligible.length === 0) {
        unplacedNew++;
        continue;
      }
      const prefers = (p: Person) => c.kind !== null && p.preferredKinds.includes(c.kind);
      const withRoom = eligible.filter((p) => room(p) > 0);
      const pool = withRoom.some(prefers) ? withRoom.filter(prefers) : withRoom.length ? withRoom : eligible;
      const pick = [...pool].sort((a, b) => room(b) - room(a) || a.userId.localeCompare(b.userId))[0]!;
      assign.push({ dossierId: c.dossierId, userId: pick.userId, bucket: "new", preferred: prefers(pick) });
      held.set(pick.userId, (held.get(pick.userId) ?? 0) + 1);
    }
  } else {
    unplacedNew = candidates.filter((x) => x.bucket === "new").length;
  }

  const research = candidates.filter((x) => x.bucket === "research").sort(oldestFirst);
  const taken = new Set<number>();
  if (mode === "drip" || mode === "all") {
    for (const p of [...working].sort((a, b) => room(b) - room(a) || a.userId.localeCompare(b.userId))) {
      const want = room(p);
      if (want <= 0) continue;
      const free = research.filter((c) => !taken.has(c.dossierId) && releasedFrom.get(c.dossierId) !== p.userId);
      const isPreferred = (c: Candidate) => c.kind !== null && p.preferredKinds.includes(c.kind);
      for (const c of [...free.filter(isPreferred), ...free.filter((c) => !isPreferred(c))].slice(0, want)) {
        taken.add(c.dossierId);
        assign.push({ dossierId: c.dossierId, userId: p.userId, bucket: "research", preferred: isPreferred(c) });
        held.set(p.userId, (held.get(p.userId) ?? 0) + 1);
      }
    }
  }

  const workingIds = new Set(working.map((p) => p.userId));
  return {
    release,
    assign,
    unplaced: { new: unplacedNew, research: research.length - taken.size },
    people: input.people.map((p) => ({ userId: p.userId, target: target(p), held: held.get(p.userId) ?? 0, working: workingIds.has(p.userId) })),
  };
}

export interface CapacityBody {
  hoursPerWeek: number;
  workingDays: number[];
  preferredKinds: string[];
  active: boolean;
}

/** Every problem with a PUT /api/management/capacity body at once, the way the Studio shows them. */
export function validateCapacityBody(body: unknown, kinds: ReadonlySet<string>): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return ["body must be an object"];
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const hours = b.hoursPerWeek;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0 || hours > 60) {
    errors.push("hoursPerWeek must be a number from 0 to 60");
  } else if (Math.abs(Math.round(hours * 10) - hours * 10) > 1e-9) {
    errors.push("hoursPerWeek has at most one decimal");
  }
  const days = b.workingDays;
  if (!Array.isArray(days) || days.length === 0 || days.length > 7 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    errors.push("workingDays must list ISO weekdays, 1 (Monday) to 7 (Sunday)");
  }
  const preferred = b.preferredKinds;
  if (!Array.isArray(preferred) || preferred.length > 20) {
    errors.push("preferredKinds must be an array of at most 20 document kinds");
  } else {
    const bad = preferred.filter((k) => typeof k !== "string" || !kinds.has(k));
    if (bad.length) errors.push(`unknown document kind: ${bad.map(String).join(", ")}`);
  }
  if (typeof b.active !== "boolean") errors.push("active must be true or false");
  return errors;
}

/** The validated body with its sets deduplicated and sorted, so what is stored is stable. */
export function normalizeCapacity(b: CapacityBody): CapacityBody {
  return {
    hoursPerWeek: b.hoursPerWeek,
    workingDays: [...new Set(b.workingDays)].sort((x, y) => x - y),
    preferredKinds: [...new Set(b.preferredKinds)].sort(),
    active: b.active,
  };
}
