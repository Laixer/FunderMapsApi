import { Hono, type Context } from "hono";
import { and, asc, count, desc, eq, exists, getTableColumns, ilike, inArray, isNull, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  dossier,
  dossierEntry,
  artifact,
  artifactPage,
  extraction,
  extractionField,
  verdict,
} from "../db/schema/dataops.ts";
import { inquiry } from "../db/schema/report.ts";
import { getDownloadUrl } from "../lib/s3.ts";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../lib/errors.ts";
import {
  MELDER_MESSAGE_KINDS,
  type MelderMessageKind,
  sendDossierClosedMail,
  sendDossierQuestionMail,
} from "../lib/intake-emails.ts";
import { addEntry } from "../lib/dossier-entries.ts";
import { fileCount, KINDS, melderRepliedLast, onDesk, readKind } from "../lib/queue-sql.ts";
import { organizationUser, user as appUser } from "../db/schema/application.ts";
import { env } from "../config.ts";
import { loadDossierAddresses } from "../lib/dossier-addresses.ts";
import { queueScopeOf } from "../lib/queue-scope.ts";
import { nowOnlyFilters, TREND_DAYS } from "../lib/queue-trend.ts";
import { existingRapportages } from "../lib/existing-rapportages.ts";
import { personName } from "../lib/person-name.ts";
import { createFollowUpDossier, finishFollowUp, isClosed, loadFollowUpSource } from "../lib/follow-up-dossier.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * The review lane.
 *
 * The pipeline proposes; a person decides. These endpoints exist so the Data
 * Studio can show a reviewer what a document said, what the model made of it,
 * and the passage it read that from -- and record the answer.
 *
 * Nothing here writes to `report.*`. Committing an accepted proposal goes
 * through the ordinary inquiry endpoints, so every validation and entry rule
 * the invoer app already enforces still applies.
 */
const dataops = new Hono<AppEnv>();

/** A dossier still on the reviewer's desk: not committed, not closed out. */

/**
 * Open-field count per dossier, as a correlated subquery so the queue can be
 * driven off `dossier` alone. The outer reference is spelled out because
 * drizzle renders `${dossier.id}` inside a select list as a bare `"id"`, which
 * Postgres resolves to the nearest table -- the subquery's own alias. A dossier with zero open fields is still in the
 * queue: the pipeline reading nothing off a document (a photo of a cat, a
 * blank scan) is exactly the case a person has to look at, and until
 * 2026-08-26 those were invisible because the queue INNER JOINed through
 * `extraction_field`.
 */
const openFields = sql<number>`(
  select count(*)::int
  from ${extractionField} f
  join ${extraction} e on e.id = f.extraction_id
  join ${artifact} a on a.id = e.artifact_id
  where a.dossier_id = "dataops"."dossier"."id"
    and f.state in ('pending', 'auto_accepted', 'rejected')
)`;

/**
 * Everything the reader proposed that is still on the table, judged or not.
 * "Niets gevonden" is this being zero -- not "nothing left open": a fully
 * judged dossier that nobody closed was landing under Niets gevonden (Don,
 * 2026-09-15, dossiers 2786 and 3003).
 */
const foundFields = sql<number>`(
  select count(*)::int
  from ${extractionField} f
  join ${extraction} e on e.id = f.extraction_id
  join ${artifact} a on a.id = e.artifact_id
  where a.dossier_id = "dataops"."dossier"."id"
    and f.state <> 'superseded'
)`;

/** Whether the pipeline has read the dossier at all. False = ingest not run yet. */
const isRead = sql<boolean>`exists (
  select 1 from ${extraction} e
  join ${artifact} a on a.id = e.artifact_id
  where a.dossier_id = "dataops"."dossier"."id"
)`;

/**
 * Search across the melder's reference, the subject, the external ref, the
 * BAG ids, the submitter's email and the uploaded filenames. Mirrors
 * `buildInquirySearchPredicate`: a bare integer is an id lookup and nothing
 * else, so the planner stays on the primary key.
 */
/** The meldcode we print in every mail to a melder, e.g. `FM2026-000111`. */
const MELDCODE = /^FM\d{4}-\d{6}$/i;

/**
 * A search that names exactly one dossier: a meldcode, or a dossier id.
 *
 * These are not filters. The reviewer has the code in front of them -- from a
 * mail, a phone call, a forwarded question -- and is asking for that dossier,
 * so the view's outcome scope and filters do not apply. Don, 2026-09-17 (#361):
 * "Someone is mailing me outside the system with a question about
 * FM2026-000111. I can't reach that dossier with this number via the search
 * field." It was dossier 5144, rejected two days earlier, and therefore
 * invisible unless you first knew to switch to the Afgewezen view -- which
 * means you had to know the answer to find the question.
 */
function isPinpointQuery(q: string | undefined): boolean {
  if (!q) return false;
  return MELDCODE.test(q) || (/^\d+$/.test(q) && Number.isSafeInteger(Number(q)));
}

function buildQueueSearchPredicate(q: string): SQL {
  // References are minted uppercase by dataops.generate_reference().
  if (MELDCODE.test(q)) return eq(dossier.reference, q.toUpperCase());
  if (/^\d+$/.test(q) && Number.isSafeInteger(Number(q))) {
    return eq(dossier.id, Number(q));
  }
  const like = `%${q}%`;
  const fileMatch = exists(
    db
      .select({ x: sql`1` })
      .from(artifact)
      .where(and(eq(artifact.dossierId, dossier.id), ilike(artifact.originalFilename, like))),
  );
  return or(
    ilike(dossier.reference, like),
    ilike(dossier.subject, like),
    ilike(dossier.externalRef, like),
    ilike(dossier.bagId, like),
    ilike(dossier.buildingId, like),
    sql`${dossier.submitter} ->> 'email' ilike ${like}`,
    fileMatch,
  )!;
}


/**
 * The display name of whoever holds the dossier, by the rule of lib/person-name.ts:
 * given + last name, else `name` when it is not an e-mail address, else the email.
 */
const assignedName = sql<string | null>`(
  select coalesce(
    nullif(concat_ws(' ', nullif(trim(u.given_name), ''), nullif(trim(u.last_name), '')), ''),
    case when u.name like '%@%' then null else nullif(trim(u.name), '') end,
    u.email)
  from application."user" u where u.id = "dataops"."dossier"."assigned_to"
)`;

const queueSelector = () =>
  db
    .select({
      id: dossier.id,
      channel: dossier.channel,
      subject: dossier.subject,
      externalRef: dossier.externalRef,
      reference: dossier.reference,
      buildingId: dossier.buildingId,
      // The pand's construction year, the date fallback for an archive drawing
      // without a readable date (#338). The Studio shows it as the estimate.
      // `dossier.building_id` is the BAG pand id (NL.IMBAG.PAND.*), which is
      // `building.external_id`; `building.id` is the internal gfm- key and
      // never matches, so this was null for every dossier until 2026-09-17.
      buildingBuiltYear: sql<string | null>`(select b.built_year::text from geocoder.building b where b.external_id = ${dossier.buildingId})`,
      receivedAt: dossier.receivedAt,
      inquiryId: dossier.inquiryId,
      auditInquiryId: dossier.auditInquiryId,
      open: openFields,
      files: fileCount,
      read: isRead,
      kind: readKind,
      outcome: dossier.outcome,
      outcomeAt: dossier.outcomeAt,
      outcomeNote: dossier.outcomeNote,
      duplicateOf: dossier.duplicateOf,
      assignedTo: dossier.assignedTo,
      assignedAt: dossier.assignedAt,
      assignedName,
    })
    .from(dossier);

/**
 * The queue's filters, every one server-side, same contract as the inquiry
 * explorer (`GET /inquiry`): comma-separated sets, combined as OR within a
 * parameter and AND across them.
 *
 *   channel   upload,email,bulk_drop,api,invoer_app
 *   state     unread (not read yet) · empty (read, nothing proposed) ·
 *             proposals (something to judge) · replied (melder had the
 *             last word) · question (no document at all: the melder asked
 *             something, and answering is the whole job -- Don 2026-09-17,
 *             7 of 16 closures that week)
 *   age       overdue -- received more than a week ago; the 24-48 h promise
 *             to a melder is long broken by then
 *   building  resolved · unresolved -- whether the submission is filed under
 *             a pand
 *   kind      report.inquiry_type codes as the pipeline read them
 *   assignedTo  me · none · <user uuid> -- who holds the dossier (API #222);
 *             absent = everyone's
 *   outcome   rejected · duplicate · no_data · accepted -- closed dossiers
 *             instead of the desk. Absent = the desk (open, uncommitted).
 *             A rejected report and a duplicate used to vanish the moment
 *             they were closed, with no way to list them again; a reviewer
 *             who wants to check yesterday's rejections needs this
 *             (ClientApp #333, point 11).
 */
const CHANNELS = new Set(["upload", "email", "bulk_drop", "api", "invoer_app", "audit"]);
const STATES = new Set(["unread", "empty", "proposals", "replied", "question"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A municipality by its CBS code (GM0363 = Amsterdam). */
const MUNICIPALITY = /^GM\d{4}$/i;
const csv = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * Which line the request is about: the desk (default), or dossiers closed
 * with one of the given outcomes. Shared by the queue and its count so the
 * number always belongs to the page it accompanies.
 */
function queueScope(c: Context<AppEnv>): SQL {
  // The rule, and why `scope=all` is a parameter of its own: lib/queue-scope.ts.
  const scope = queueScopeOf({
    outcomes: csv(c.req.query("outcome")),
    states: csv(c.req.query("state")),
    scope: c.req.query("scope"),
  });
  if (scope.kind === "all") return sql`true`;
  if (scope.kind === "desk") return onDesk()!;
  return inArray(dossier.outcome, scope.outcomes);
}

function queueFilters(c: Context<AppEnv>): SQL[] {
  const where: SQL[] = [];

  const channels = csv(c.req.query("channel"));
  if (channels.length) {
    const bad = channels.filter((x) => !CHANNELS.has(x));
    if (bad.length) throw new ValidationError([`unknown channel: ${bad.join(", ")}`]);
    where.push(inArray(dossier.channel, channels));
  }

  const states = csv(c.req.query("state"));
  if (states.length) {
    const bad = states.filter((x) => !STATES.has(x));
    if (bad.length) throw new ValidationError([`unknown state: ${bad.join(", ")}`]);
    const parts: SQL[] = [];
    if (states.includes("unread")) parts.push(sql`not ${isRead}`);
    if (states.includes("empty")) parts.push(sql`(${isRead} and ${foundFields} = 0)`);
    if (states.includes("proposals")) parts.push(sql`${openFields} > 0`);
    if (states.includes("replied")) parts.push(melderRepliedLast);
    if (states.includes("question")) parts.push(sql`${fileCount} = 0`);
    where.push(or(...parts)!);
  }

  const age = c.req.query("age");
  if (age === "overdue") where.push(sql`${dossier.receivedAt} < now() - interval '7 days'`);
  else if (age) throw new ValidationError([`unknown age: ${age}`]);

  const building = c.req.query("building");
  if (building === "resolved") where.push(isNotNull(dossier.buildingId));
  else if (building === "unresolved") where.push(isNull(dossier.buildingId));
  else if (building) throw new ValidationError([`unknown building filter: ${building}`]);

  const assignedTo = c.req.query("assignedTo");
  if (assignedTo === "me") where.push(eq(dossier.assignedTo, c.get("user").id));
  else if (assignedTo === "none") where.push(isNull(dossier.assignedTo));
  else if (assignedTo && UUID.test(assignedTo)) where.push(eq(dossier.assignedTo, assignedTo));
  else if (assignedTo) throw new ValidationError([`assignedTo must be me, none or a user id`]);

  const kinds = csv(c.req.query("kind"));
  if (kinds.length) {
    const bad = kinds.filter((x) => !KINDS.has(x));
    if (bad.length) throw new ValidationError([`unknown kind: ${bad.join(", ")}`]);
    where.push(inArray(readKind, kinds));
  }

  // The dossiers of one municipality, by CBS code (2026-10-22): a click on the
  // Datastroom's map. Through the pand, so a dossier without one is not in it.
  const municipality = c.req.query("municipality");
  if (municipality && !MUNICIPALITY.test(municipality)) {
    throw new ValidationError(["municipality must be a CBS code like GM0363"]);
  }
  if (municipality) {
    where.push(sql`exists (
      select 1 from geocoder.building b
      join geocoder.neighborhood n on n.id = b.neighborhood_id
      join geocoder.district di on di.id = n.district_id
      join geocoder.municipality m on m.id = di.municipality_id
      where b.external_id = ${dossier.buildingId} and m.external_id = ${municipality.toUpperCase()}
    )`);
  }

  return where;
}

/**
 * Sort columns. Every ordering ends on the primary key so LIMIT/OFFSET pages
 * are total (the lesson of FunderMapsApi #101). The default stays oldest
 * first: this is a waiting line.
 */
const SORTS = {
  received_at: dossier.receivedAt,
  outcome_at: dossier.outcomeAt,
  open: openFields,
  files: fileCount,
  subject: dossier.subject,
  id: dossier.id,
} as const;
type QueueSort = keyof typeof SORTS;

function queueOrder(c: Context<AppEnv>): SQL[] {
  const sort = c.req.query("sort") ?? "received_at";
  if (!(sort in SORTS)) throw new ValidationError([`unknown sort: ${sort}`]);
  const order = c.req.query("order") ?? (sort === "received_at" ? "asc" : "desc");
  if (order !== "asc" && order !== "desc") throw new ValidationError([`order must be asc or desc`]);
  const dir = order === "asc" ? asc : desc;
  const col = SORTS[sort as QueueSort];
  return sort === "id" ? [dir(dossier.id)] : [dir(col), asc(dossier.id)];
}

/**
 * The queue, oldest first.
 *
 * Oldest first is deliberate: a terugmelding carries a 24-48 hour promise to
 * the person who sent it, so the queue is a waiting line, not a feed.
 *
 * Same contract as `GET /inquiry`: `q`, `limit`, `offset`. Bare browse pages
 * at 100, a search at 500; the client can override either.
 *
 * `scope=all` drops the desk restriction: open and closed dossiers alike, the
 * other filters still applying. The Studio sends it with a search on "Alles"
 * (#191); see lib/queue-scope.ts.
 */
dataops.get("/queue", async (c) => {
  const q = c.req.query("q")?.trim();
  const limit = parseInt(c.req.query("limit") ?? (q ? "500" : "100"));
  const offset = parseInt(c.req.query("offset") ?? "0");
  if (!Number.isFinite(limit) || limit < 1 || !Number.isFinite(offset) || offset < 0) {
    throw new ValidationError(["limit must be >= 1 and offset >= 0"]);
  }

  // A meldcode or an id addresses one dossier, so it reaches past the view.
  const where: SQL[] = isPinpointQuery(q) ? [] : [queueScope(c), ...queueFilters(c)];
  if (q) where.push(buildQueueSearchPredicate(q));

  const rows = await queueSelector()
    .where(and(...where))
    // Tie-break on the key: several dossiers share one received_at when a
    // bulk drop lands, and LIMIT/OFFSET over a partial order loses rows.
    .orderBy(...queueOrder(c))
    .limit(limit)
    .offset(offset);

  return c.json(rows);
});

/** How long the line is. The sidebar counter; never derived from a page. */
dataops.get("/queue/stats", async (c) => {
  // Takes the same filters as the queue, so a count always answers the
  // question the page it accompanies asks. Bare = the whole line.
  const q = c.req.query("q")?.trim();
  const where: SQL[] = isPinpointQuery(q) ? [] : [queueScope(c), ...queueFilters(c)];
  if (q) where.push(buildQueueSearchPredicate(q));
  const [row] = await db
    .select({ count: count() })
    .from(dossier)
    .where(and(...where));
  return c.json({ count: row?.count ?? 0 });
});

/**
 * The same slice over the last 30 Amsterdam days (2026-10-23): how many were
 * open at the end of each day, how many got an outcome that day, and now the
 * oldest open one and how many wait longer than a week. The Grafana board
 * "Operations" (work packages over time), moved into the Studio's Vandaag.
 *
 * "Open at the end of day d" = received before the next midnight and without an
 * outcome yet then. A dossier leaves the desk with an outcome (onDesk also asks
 * for no rapportage, and on 2026-10-23 no dossier had one without an outcome),
 * so the last point is the desk count of /queue/stats with the same filters.
 * A reopened dossier counts as open since its receipt; a closed one without a
 * recorded moment never counts as open.
 *
 * Takes the filters on a dossier's own facts only; one that describes now
 * (state, age, assignedTo, outcome, scope) is a 400 — see lib/queue-trend.ts.
 */
dataops.get("/queue/trend", async (c) => {
  const refused = nowOnlyFilters(c.req.query());
  if (refused.length) {
    throw new ValidationError([`a trend cannot filter on how a dossier stands now: ${refused.join(", ")}`]);
  }
  const q = c.req.query("q")?.trim();
  const where: SQL[] = [...queueFilters(c)];
  if (q) where.push(buildQueueSearchPredicate(q));

  const [days, now] = await Promise.all([
    db.execute(sql`
      WITH x AS (
        SELECT coalesce(received_at, created_at) AS rcv, outcome, outcome_at, inquiry_id
        FROM ${dossier} WHERE ${where.length ? and(...where) : sql`true`}
      ),
      days AS (
        SELECT d::date AS day,
          d AT TIME ZONE 'Europe/Amsterdam' AS start,
          (d + interval '1 day') AT TIME ZONE 'Europe/Amsterdam' AS next
        FROM generate_series(
          (now() AT TIME ZONE 'Europe/Amsterdam')::date - ${TREND_DAYS - 1}::int,
          (now() AT TIME ZONE 'Europe/Amsterdam')::date,
          interval '1 day') AS d
      )
      SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
        count(x.rcv) FILTER (WHERE x.rcv < days.next
          AND (x.outcome IS NULL OR x.outcome_at >= days.next)
          AND (x.inquiry_id IS NULL OR x.outcome IS NOT NULL))::int AS open,
        count(x.rcv) FILTER (WHERE x.outcome_at >= days.start AND x.outcome_at < days.next)::int AS handled
      FROM days LEFT JOIN x ON true
      GROUP BY days.day ORDER BY days.day
    `),
    db.execute(sql`
      SELECT count(*)::int AS open,
        ((now() AT TIME ZONE 'Europe/Amsterdam')::date
          - (min(coalesce(received_at, created_at)) AT TIME ZONE 'Europe/Amsterdam')::date)::int AS "oldestDays",
        count(*) FILTER (WHERE coalesce(received_at, created_at) < now() - interval '7 days')::int AS "overWeek"
      FROM ${dossier} WHERE ${and(onDesk()!, ...where)}
    `),
  ]);

  const series = days as unknown as { day: string; open: number; handled: number }[];
  const n = (now as unknown as { open: number; oldestDays: number | null; overWeek: number }[])[0];
  return c.json({
    days: series.map((d) => d.day),
    open: series.map((d) => d.open),
    handled: series.map((d) => d.handled),
    now: { open: n?.open ?? 0, oldestDays: n?.oldestDays ?? null, overWeek: n?.overWeek ?? 0 },
  });
});

/**
 * One dossier, with everything a reviewer needs on screen at once: the values,
 * the evidence, and a link to the page they came from.
 */
dataops.get("/dossier/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);

  const [head] = await db
    .select({
      ...getTableColumns(dossier),
      // The pand's construction year, the date fallback for an archive drawing
      // without a readable date (#338). The queue list has carried this since
      // 2026-09-17; the detail did not, so on the dossier screen the estimate
      // was always null and "Overnemen als rapportage" stayed disabled for an
      // archive dossier whose document has no date (#195, Don 2026-09-20).
      buildingBuiltYear: sql<string | null>`(select b.built_year::text from geocoder.building b where b.external_id = ${dossier.buildingId})`,
      assignedName,
      // What the model says about the pand right now, next to what the melder
      // claims ("Risico volgens melder", "Funderingstype volgens melder"):
      // Don, 2026-09-25, dossier 5594. Null without a pand or a model row.
      buildingModel: sql<{
        foundationType: string | null;
        foundationTypeReliability: string | null;
        drystandRisk: string | null;
        dewateringDepthRisk: string | null;
        bioInfectionRisk: string | null;
        unclassifiedRisk: string | null;
      } | null>`(select json_build_object(
          'foundationType', m.foundation_type,
          'foundationTypeReliability', m.foundation_type_reliability,
          'drystandRisk', m.drystand_risk,
          'dewateringDepthRisk', m.dewatering_depth_risk,
          'bioInfectionRisk', m.bio_infection_risk,
          'unclassifiedRisk', m.unclassified_risk)
        from data.model_risk_static m where m.building_id = ${dossier}.building_id)`,
      // Qualified on purpose: model_risk_static has its own building_id, so a bare
      // "building_id" here resolved to m.building_id, matched every row and made
      // every dossier detail a 500 (#215, 2026-09-28).
    })
    .from(dossier)
    .where(eq(dossier.id, id))
    .limit(1);
  if (!head) throw new NotFoundError("dossier not found");

  const artifacts = await db
    .select()
    .from(artifact)
    .where(eq(artifact.dossierId, id))
    .orderBy(asc(artifact.id));

  const artifactIds = artifacts.map((a) => a.id);
  const [pages, fields] = await Promise.all([
    artifactIds.length
      ? db
          .select()
          .from(artifactPage)
          .where(inArray(artifactPage.artifactId, artifactIds))
          .orderBy(asc(artifactPage.artifactId), asc(artifactPage.pageNo))
      : [],
    artifactIds.length
      ? db
          .select({
            id: extractionField.id,
            artifactId: extraction.artifactId,
            field: extractionField.field,
            value: extractionField.value,
            confidence: extractionField.confidence,
            evidence: extractionField.evidence,
            evidencePage: extractionField.evidencePage,
            state: extractionField.state,
            addressText: extractionField.addressText,
            addressId: extractionField.addressId,
            currentValue: extractionField.currentValue,
            model: extraction.model,
            promptVersion: extraction.promptVersion,
          })
          .from(extractionField)
          .innerJoin(extraction, eq(extraction.id, extractionField.extractionId))
          .where(inArray(extraction.artifactId, artifactIds))
          // The report's order, not the schema's: address group, then where
          // the citation sits in the text (Worker writes it at ingest since
          // ClientApp #333 point 2; older rows have nulls and sort last, so
          // they keep their alphabetical order until re-read).
          .orderBy(
            asc(extractionField.addressText),
            sql`${extractionField.evidenceOffset} nulls last`,
            sql`${extractionField.evidencePage} nulls last`,
            asc(extractionField.field),
            asc(extractionField.id),
          )
      : [],
  ]);

  // Signed links are minted here; the browser never sees storage credentials.
  const [withLinks, entries, addresses, existing] = await Promise.all([
    Promise.all(
      artifacts.map(async (a) => ({
        ...a,
        accessLink: await getDownloadUrl(a.storageKey, 4),
        pages: pages.filter((p) => p.artifactId === a.id),
      })),
    ),
    db.select().from(dossierEntry).where(eq(dossierEntry.dossierId, id)).orderBy(asc(dossierEntry.at), asc(dossierEntry.id)),
    // The addresses this dossier is about: its own pand, what the document
    // names, and what the reviewer decided (ClientApp #333 part C).
    loadDossierAddresses(id, head),
    // Rapportages already on this pand, for the warning before "Overnemen als
    // rapportage" (Don, 2026-10-08: Molenwal 15 had one survey five times).
    head.buildingId
      ? existingRapportages(head.buildingId, artifacts.map((a) => a.sizeBytes), head.inquiryId ?? head.auditInquiryId ?? null)
      : Promise.resolve([]),
  ]);

  return c.json({ dossier: head, artifacts: withLinks, fields, entries, addresses, existingRapportages: existing });
});

/**
 * Record what the reviewer decided.
 *
 * One row per judged field, never a single verdict for a whole document: a
 * document routinely yields six values where five are solid and one is a
 * stretch, and an all-or-nothing answer throws away the good ones or waves
 * through the bad one.
 *
 * `corrected` carries the value the human put instead. That pair is the
 * training set -- today's labels come from a cover sheet an invoerder writes
 * before uploading, and once the pipeline reads documents instead, nobody
 * writes those any more.
 *
 * `fieldIds: number[]` judges several fields in one call, for the case
 * Worker#186 is about: a report whose cover says "Olympiaweg 20-92" describes
 * 40 panden, the ingest expands that into one proposal per pand, and asking a
 * reviewer to click the same verdict 40 times would be a worse tool than the
 * one that could not expand the range at all. It stays **one verdict row per
 * field** -- the table is the training set, and forty buildings that were
 * judged are forty labels, not one. What is shared is the click, not the
 * evidence.
 *
 * `fieldId` (singular) still works and means a list of one.
 */

/** A group verdict covers a range in one report; the widest seen is 127 addresses on 40 panden. */
const MAX_VERDICT_FIELDS = 500;

dataops.post("/verdict", async (c) => {
  const u = c.get("user");
  const body = await c.req.json<{
    fieldId?: number;
    fieldIds?: number[];
    outcome: "confirmed" | "corrected" | "rejected";
    finalValue?: string | null;
    note?: string | null;
    reviewSeconds?: number | null;
  }>();

  const requested = body.fieldIds ?? (body.fieldId != null ? [body.fieldId] : []);
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new ValidationError(["fieldId or a non-empty fieldIds array is required"]);
  }
  if (!requested.every((id) => Number.isInteger(id) && id > 0)) {
    throw new ValidationError(["every field id must be a positive integer"]);
  }
  if (requested.length > MAX_VERDICT_FIELDS) {
    throw new ValidationError([`at most ${MAX_VERDICT_FIELDS} fields in one verdict`]);
  }
  const fieldIds = [...new Set(requested)];
  if (!["confirmed", "corrected", "rejected"].includes(body.outcome)) {
    throw new ValidationError(["outcome must be confirmed, corrected or rejected"]);
  }
  if (body.outcome === "corrected" && !body.finalValue?.trim()) {
    throw new ValidationError(["a corrected verdict needs the value the reviewer put instead"]);
  }

  const fields = await db
    .select({
      id: extractionField.id,
      field: extractionField.field,
      value: extractionField.value,
      dossierId: artifact.dossierId,
    })
    .from(extractionField)
    .innerJoin(extraction, eq(extraction.id, extractionField.extractionId))
    .innerJoin(artifact, eq(artifact.id, extraction.artifactId))
    .where(inArray(extractionField.id, fieldIds));
  if (fields.length === 0) throw new NotFoundError("field not found");
  if (fields.length !== fieldIds.length) {
    const missing = fieldIds.filter((id) => !fields.some((f) => f.id === id));
    throw new NotFoundError(`field not found: ${missing.join(", ")}`);
  }
  // One dossier per call. Without this a caller could judge another dossier's
  // fields by slipping an id into the array, and the timeline entry below --
  // which is written once -- would land on whichever dossier happened to be
  // first.
  const dossierId = fields[0]!.dossierId;
  if (fields.some((f) => f.dossierId !== dossierId)) {
    throw new ValidationError(["all fields must belong to the same dossier"]);
  }

  const verdictIds = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(verdict)
      .values(
        fields.map((f, i) => ({
          extractionFieldId: f.id,
          decidedBy: u.id,
          outcome: body.outcome,
          finalValue: body.finalValue ?? null,
          note: body.note ?? null,
          // The reviewer spent that time once, on the group. Repeating it on
          // every row would multiply the only honest measure we have of how
          // long reviewing actually takes.
          reviewSeconds: i === 0 ? (body.reviewSeconds ?? null) : null,
        })) as (typeof verdict.$inferInsert)[],
      )
      .returning({ id: verdict.id });

    await tx
      .update(extractionField)
      .set({ state: body.outcome })
      .where(inArray(extractionField.id, fieldIds));

    return rows.map((r) => r.id);
  });

  // Same wording the 2026-09-04 backfill used, so old and new lines read alike.
  const verb =
    body.outcome === "confirmed"
      ? "Waarde overgenomen"
      : body.outcome === "corrected"
        ? "Waarde aangepast"
        : "Waarde afgekeurd";
  const head = fields[0]!;
  // One line for the group. Forty lines saying the same thing would bury the
  // rest of the dossier's history, which is what the timeline is for.
  await addEntry({
    dossierId,
    kind: "verdict",
    actorKind: "reviewer",
    actor: u.id,
    text:
      `${verb}: ${head.field} = ${body.finalValue ?? head.value ?? "—"}` +
      (fields.length > 1 ? ` — op ${fields.length} adressen tegelijk` : "") +
      (body.note?.trim() ? ` — ${body.note.trim()}` : ""),
    verdictId: verdictIds[0]!,
    visibleToMelder: false,
  });

  return c.json({ ok: true, count: verdictIds.length });
});

/**
 * Undo a verdict while the dossier is still open (ClientApp #355; Don,
 * 2026-09-17, after accepting the wrong foundation type twice in a day: "let
 * the reviewer do this himself, as long as the dossier is open").
 *
 * The field goes back to 'pending'; the earlier verdict row stays (the
 * verdict table is append-only training data) and the dossier's timeline
 * records who reopened what and what it was, so the log shows the mistake and
 * the correction. No verdict row marks the reopen: dataops.verdict refuses
 * outcome 'pending' (CHECK verdict_outcome_check), which made every reopen a
 * 500 from 2026-09-17 to 2026-09-23. What counts at commit is the field's
 * current state plus its latest confirming verdict (dataops-commit.ts).
 * Refused once the dossier is closed or committed: the verdict has then left
 * the dossier (409).
 */
dataops.post("/field/:id/reopen", async (c) => {
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["field id is required"]);

  const [field] = await db
    .select({
      id: extractionField.id,
      field: extractionField.field,
      value: extractionField.value,
      state: extractionField.state,
      dossierId: artifact.dossierId,
      outcome: dossier.outcome,
      inquiryId: dossier.inquiryId,
    })
    .from(extractionField)
    .innerJoin(extraction, eq(extraction.id, extractionField.extractionId))
    .innerJoin(artifact, eq(artifact.id, extraction.artifactId))
    .innerJoin(dossier, eq(dossier.id, artifact.dossierId))
    .where(eq(extractionField.id, id))
    .limit(1);
  if (!field) throw new NotFoundError("field not found");
  if (field.outcome || field.inquiryId) {
    throw new ConflictError("the dossier is closed or committed; the verdict cannot be reopened");
  }
  if (!["confirmed", "corrected", "rejected"].includes(field.state)) {
    throw new ConflictError(`the field is ${field.state}, there is no verdict to reopen`);
  }

  // Only if nobody judged the field in the meantime: otherwise this would
  // silently wipe that newer verdict.
  const reset = await db
    .update(extractionField)
    .set({ state: "pending" })
    .where(and(eq(extractionField.id, id), eq(extractionField.state, field.state)))
    .returning({ id: extractionField.id });
  if (reset.length === 0) {
    throw new ConflictError("the field was judged again in the meantime; reload and try again");
  }

  await addEntry({
    dossierId: field.dossierId,
    kind: "verdict",
    actorKind: "reviewer",
    actor: u.id,
    text: `Beoordeling heropend: ${field.field} = ${field.value ?? "—"} (was ${field.state})`,
    visibleToMelder: false,
  });

  return c.json({ ok: true });
});

type DossierOutcome = "accepted" | "rejected" | "duplicate" | "no_data";
const OUTCOMES: readonly DossierOutcome[] = ["accepted", "rejected", "duplicate", "no_data"];

/**
 * Close dossiers as a whole.
 *
 * The per-field verdict cannot express "this document is not about anything"
 * -- a photo of a cat, a duplicate, a report filed under the wrong address.
 * That decision is about the dossier, so it lives on the dossier: `outcome`
 * with a note, and every open value on it marked `superseded` so it stops
 * counting as work.
 *
 *   accepted   worked through; values taken over elsewhere
 *   rejected   we could not use this -- the melder is told so (note required)
 *   duplicate  we already held it -- the melder is NOT told it was a fault (note required)
 *   no_data    we looked, nothing to take: a logo, a photo of the street, a
 *              maintenance plan. Added 2026-08-29 after Don closed 30 logos as
 *              'accepted' for lack of anything truer.
 *
 * Bulk is the same operation over a list, in one transaction, because the
 * bulk case (30 promo images in a row) is exactly the one that must not fail
 * halfway.
 */
const OUTCOME_LINE: Record<DossierOutcome, string> = {
  accepted: "Afgehandeld",
  rejected: "Afgewezen",
  duplicate: "Gesloten als duplicaat",
  no_data: "Gesloten: geen funderingsgegevens",
};

async function closeDossiers(
  ids: number[],
  outcome: DossierOutcome,
  note: string | null,
  actor: string,
  inquiryId: number | null = null,
) {
  const heads = await db
    .select({ id: dossier.id, outcome: dossier.outcome, inquiryId: dossier.inquiryId })
    .from(dossier)
    .where(inArray(dossier.id, ids));
  const missing = ids.filter((id) => !heads.some((h) => h.id === id));
  if (missing.length) throw new NotFoundError(`dossier not found: ${missing.join(", ")}`);
  const closed = heads.filter((h) => h.outcome);
  if (closed.length) {
    throw new ValidationError(closed.map((h) => `dossier ${h.id} already closed as ${h.outcome}`));
  }
  if (inquiryId !== null) {
    const linkedElsewhere = heads.filter((h) => h.inquiryId !== null && h.inquiryId !== inquiryId);
    if (linkedElsewhere.length) {
      throw new ValidationError(linkedElsewhere.map((h) => `dossier ${h.id} is already linked to rapportage ${h.inquiryId}`));
    }
    const [found] = await db
      .select({ id: inquiry.id })
      .from(inquiry)
      .where(and(eq(inquiry.id, inquiryId), isNull(inquiry.deleteDate)));
    if (!found) throw new NotFoundError(`rapportage not found: ${inquiryId}`);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(dossier)
      .set({ outcome, outcomeNote: note, outcomeAt: new Date(), ...(inquiryId !== null ? { inquiryId } : {}) })
      .where(inArray(dossier.id, ids));
    // Only values nobody judged. 'rejected' is also what a reviewer's Afkeuren
    // sets, and the first version of this relabelled 16 of Don's rejections
    // as superseded when he closed the dossier (2026-08-29). A field with a
    // verdict is a decision taken; closing the dossier does not undo it.
    await tx.execute(sql`
      update ${extractionField} f set state = 'superseded'
      from ${extraction} e join ${artifact} a on a.id = e.artifact_id
      where e.id = f.extraction_id and a.dossier_id in ${ids}
        and f.state in ('pending', 'auto_accepted', 'rejected')
        and not exists (select 1 from ${verdict} v where v.extraction_field_id = f.id)`);
  });

  for (const id of ids) {
    await addEntry({
      dossierId: id,
      kind: "status",
      actorKind: "reviewer",
      actor,
      text: OUTCOME_LINE[outcome] + (note ? ` — ${note}` : ""),
      body: { outcome },
      visibleToMelder: true,
    });
  }

  // Moment 3 of tracker #1020: the melder hears what became of it. Only
  // dossiers with a submitter get mail (bulk drops have none); one mail per
  // dossier however often this or /commit runs (dataops.dossier_mail).
  await sendDossierClosedMail(ids);
}

function parseOutcome(body: { outcome?: string; note?: string | null }) {
  if (!OUTCOMES.includes(body.outcome as DossierOutcome)) {
    throw new ValidationError([`outcome must be one of ${OUTCOMES.join(", ")}`]);
  }
  const outcome = body.outcome as DossierOutcome;
  const note = body.note?.trim() || null;
  if ((outcome === "rejected" || outcome === "duplicate") && !note) {
    throw new ValidationError(["say why: a rejected or duplicate dossier needs a note"]);
  }
  return { outcome, note };
}

/**
 * The rapportage an accepted dossier became, when it was entered outside the
 * commit path (Studio editor or API, then approved in Controle). Without the
 * link the melder is told nothing follows and gets no risk follow-up mail:
 * 52 of 89 accepted meldingen in two weeks to 2026-10-27.
 */
function parseInquiryId(body: { inquiryId?: unknown }, outcome: DossierOutcome): number | null {
  if (body.inquiryId === undefined || body.inquiryId === null) return null;
  const inquiryId = Number(body.inquiryId);
  if (!Number.isInteger(inquiryId) || inquiryId <= 0) throw new ValidationError(["inquiryId must be a rapportage id"]);
  if (outcome !== "accepted") throw new ValidationError(["inquiryId only goes with outcome accepted"]);
  return inquiryId;
}

dataops.post("/dossier/:id/outcome", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const body = await c.req.json<{ outcome?: string; note?: string | null; inquiryId?: unknown }>();
  const { outcome, note } = parseOutcome(body);
  await closeDossiers([id], outcome, note, c.get("user").id, parseInquiryId(body, outcome));
  return c.json({ ok: true });
});

dataops.post("/dossiers/outcome", async (c) => {
  const body = await c.req.json<{ ids?: unknown; outcome?: string; note?: string | null }>();
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  if (!ids.length || ids.some((id) => !Number.isFinite(id))) {
    throw new ValidationError(["ids must be a non-empty list of dossier ids"]);
  }
  if (ids.length > 200) throw new ValidationError(["at most 200 dossiers per call"]);
  const { outcome, note } = parseOutcome(body);
  await closeDossiers([...new Set(ids)], outcome, note, c.get("user").id);
  return c.json({ ok: true, closed: new Set(ids).size });
});

/**
 * A note on the dossier itself, for what the per-field verdicts cannot say:
 * "called the melder", "waiting for the offerte", "check the second address".
 * Internal -- the melder never sees these.
 */
dataops.post("/dossier/:id/remark", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const body = await c.req.json<{ text?: string }>();
  const text = body.text?.trim() ?? "";
  if (!text) throw new ValidationError(["text is required"]);
  if (text.length > 4000) throw new ValidationError(["text must be at most 4000 characters"]);

  const [head] = await db.select({ id: dossier.id }).from(dossier).where(eq(dossier.id, id)).limit(1);
  if (!head) throw new NotFoundError("dossier not found");

  await addEntry({
    dossierId: id,
    kind: "remark",
    actorKind: "reviewer",
    actor: c.get("user").id,
    text,
    visibleToMelder: false,
  });
  return c.json({ ok: true });
});

/**
 * Write to the melder: ask something, or answer them (`kind`, default
 * 'question'; 'answer' since API #209). The message is mailed (Resend, from
 * melding@funderdata.nl with the dossier reference in the reply address) and
 * recorded on the timeline; the melder's reply comes back through the inbound
 * webhook (routes/webhooks.ts) as a 'reply' entry.
 *
 * Both kinds are a 'question' entry -- "the reviewer wrote to the melder", the
 * kind the queue states read -- with the kind in `body.mail.kind`.
 *
 * Unlike the courtesy mails this endpoint fails loudly: a reviewer who writes
 * to the melder must know whether it actually went out.
 */
dataops.post("/dossier/:id/question", async (c) => {
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const body = await c.req.json<{ text?: string; kind?: string }>();
  const text = body.text?.trim() ?? "";
  if (!text) throw new ValidationError(["text is required"]);
  if (text.length > 4000) throw new ValidationError(["text must be at most 4000 characters"]);
  const kind = (body.kind ?? "question") as MelderMessageKind;
  if (!MELDER_MESSAGE_KINDS.includes(kind)) {
    throw new ValidationError([`kind must be one of: ${MELDER_MESSAGE_KINDS.join(", ")}`]);
  }

  const [head] = await db.select().from(dossier).where(eq(dossier.id, id)).limit(1);
  if (!head) throw new NotFoundError("dossier not found");
  // A closed dossier can still be answered. The melder writes back after the
  // afronding ("via welke weg dan wel?", FM2026-000107, 2026-09-15) and the
  // reviewer must be able to reply from the same screen; the outcome stays.

  const sent = await sendDossierQuestionMail(head, text, kind);
  if (!sent.ok) {
    if (!sent.recipient) throw new ValidationError(["dossier has no melder email"]);
    throw new AppError(502, `mail not sent: ${sent.error ?? "unknown"}`);
  }

  await addEntry({
    dossierId: id,
    kind: "question",
    actorKind: "reviewer",
    actor: u.id,
    text,
    // The entry's `text` is the reviewer's own words; `body.mail` is the letter
    // that actually left the building, in the shape API #176 gave the automated
    // mails so the review log can render all of them the same way (#356).
    body: sent.subject
      ? { mail: { kind, to: sent.recipient, subject: sent.subject, text: sent.text } }
      : undefined,
    visibleToMelder: true,
    mailMessageId: sent.id ?? null,
  });
  return c.json({ ok: true });
});

/**
 * Files that already sit on a closed dossier, into a vervolgmelding (Don,
 * 2026-10-12): what the reply webhook now does by itself
 * (lib/reply-attachments.ts), for documents that arrived before it did, or
 * another way. `{ artifactIds }`, all of this dossier.
 *
 * The documents are COPIED (same storage key, new artifact row on the new
 * dossier), not moved: the API role may insert into dataops.artifact but not
 * update it, and the closed dossier keeps the record of what it was sent.
 */
dataops.post("/dossier/:id/follow-up", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const body = await c.req.json<{ artifactIds?: unknown }>();
  const ids = Array.isArray(body.artifactIds) ? [...new Set(body.artifactIds.map(Number))] : [];
  if (!ids.length || ids.some((a) => !Number.isInteger(a))) {
    throw new ValidationError(["artifactIds must be a non-empty list of artifact ids"]);
  }
  if (ids.length > 50) throw new ValidationError(["at most 50 artifacts per call"]);

  const source = await loadFollowUpSource(id);
  if (!source) throw new NotFoundError("dossier not found");
  if (!isClosed(source)) throw new ValidationError(["dossier is still open; its documents are reviewed there"]);

  const files = await db
    .select()
    .from(artifact)
    .where(and(eq(artifact.dossierId, id), inArray(artifact.id, ids)))
    .orderBy(asc(artifact.id));
  const foreign = ids.filter((a) => !files.some((f) => f.id === a));
  if (foreign.length) throw new ValidationError([`not a document of dossier ${id}: ${foreign.join(", ")}`]);

  const { created, copies } = await db.transaction(async (tx) => {
    const created = await createFollowUpDossier(tx, source);
    const copies = await tx
      .insert(artifact)
      .values(files.map((f) => ({
        dossierId: created.id,
        storageKey: f.storageKey,
        originalFilename: f.originalFilename,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        declaredCategory: f.declaredCategory,
        // Read afresh on the new dossier.
        lane: "none",
      })))
      .returning({ id: artifact.id });
    return { created, copies };
  });

  const by = { actorKind: "reviewer" as const, actor: c.get("user").id };
  await addEntry({
    dossierId: created.id,
    kind: "status", ...by,
    text: `Overgenomen uit ${source.reference ?? `melding ${id}`}: ${files.map((f) => f.originalFilename ?? `document ${f.id}`).join(", ")}`,
    body: { copied_from: files.map((f, i) => ({ artifact_id: f.id, copy_id: copies[i]!.id })) },
    visibleToMelder: false,
  });
  await finishFollowUp(source, created, by);
  return c.json({ ok: true, dossierId: created.id, reference: created.reference });
});

/**
 * Hand a dossier to a colleague, or back to the general queue (API #222).
 *
 * A reviewer sometimes needs a decision from a specific person (usually the
 * product owner) on a dossier. Before this, the hand-over happened outside the
 * system and the dossier stayed in the general queue with nobody visibly
 * holding it. `{ userId }` hands it over, `{ userId: null }` puts it back;
 * `note` says what the colleague is asked. Only staff (members of the platform
 * organisation) can hold a dossier. Open or closed: a reply after the
 * afronding may need the same person.
 *
 * The timeline gets a 'status' line marked `body.assignment`, so the
 * "Reactie ontvangen" rule (melderRepliedLast) does not read a hand-over as
 * an answer to the melder.
 */
dataops.post("/dossier/:id/assign", async (c) => {
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const body = await c.req.json<{ userId?: string | null; note?: string }>();
  const userId = body.userId ?? null;
  const note = body.note?.trim() ?? "";
  if (userId !== null && !UUID.test(userId)) throw new ValidationError(["userId must be a user id or null"]);
  if (note.length > 1000) throw new ValidationError(["note must be at most 1000 characters"]);

  const [head] = await db
    .select({ id: dossier.id, assignedTo: dossier.assignedTo })
    .from(dossier)
    .where(eq(dossier.id, id))
    .limit(1);
  if (!head) throw new NotFoundError("dossier not found");

  let name: string | null = null;
  if (userId) {
    const [m] = await db
      .select({ name: appUser.name, givenName: appUser.givenName, lastName: appUser.lastName, email: appUser.email })
      .from(appUser)
      .innerJoin(
        organizationUser,
        and(eq(organizationUser.userId, appUser.id), eq(organizationUser.organizationId, env.PLATFORM_ORGANIZATION_ID)),
      )
      .where(eq(appUser.id, userId))
      .limit(1);
    if (!m) throw new ValidationError(["userId is not a staff member"]);
    name = personName(m);
  }
  if ((head.assignedTo ?? null) === userId) return c.json({ ok: true, unchanged: true });

  await db
    .update(dossier)
    .set({ assignedTo: userId, assignedAt: userId ? new Date() : null, updatedAt: new Date() })
    .where(eq(dossier.id, id));

  const what = userId ? `Doorgezet naar ${name}` : "Terug in de algemene wachtrij";
  await addEntry({
    dossierId: id,
    kind: "status",
    actorKind: "reviewer",
    actor: u.id,
    text: note ? `${what}: ${note}` : what,
    body: { assignment: { to: userId, from: head.assignedTo ?? null, ...(note ? { note } : {}) } },
    visibleToMelder: false,
  });
  return c.json({ ok: true });
});

export default dataops;
