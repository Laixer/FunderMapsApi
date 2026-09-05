import { Hono } from "hono";
import { and, asc, count, eq, exists, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
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
import { getDownloadUrl } from "../lib/s3.ts";
import { AppError, NotFoundError, ValidationError } from "../lib/errors.ts";
import { sendDossierClosedMail, sendDossierQuestionMail } from "../lib/intake-emails.ts";
import { addEntry } from "../lib/dossier-entries.ts";
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

/**
 * States a reviewer still has to look at.
 *
 * `auto_accepted` is legacy: the Worker's confidence gate was removed on
 * 2026-08-26 (100% of intake is reviewed by a person), but rows written before
 * that still carry the value, and they were never looked at either.
 */
const OPEN = ["pending", "auto_accepted", "rejected"] as const;

/** A dossier still on the reviewer's desk: not committed, not closed out. */
const onDesk = () => and(isNull(dossier.inquiryId), isNull(dossier.outcome));

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

const fileCount = sql<number>`(
  select count(*)::int from ${artifact} a where a.dossier_id = "dataops"."dossier"."id"
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
function buildQueueSearchPredicate(q: string): SQL {
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

const queueSelector = () =>
  db
    .select({
      id: dossier.id,
      channel: dossier.channel,
      subject: dossier.subject,
      externalRef: dossier.externalRef,
      reference: dossier.reference,
      buildingId: dossier.buildingId,
      receivedAt: dossier.receivedAt,
      inquiryId: dossier.inquiryId,
      open: openFields,
      files: fileCount,
      read: isRead,
    })
    .from(dossier);

/**
 * The queue, oldest first.
 *
 * Oldest first is deliberate: a terugmelding carries a 24-48 hour promise to
 * the person who sent it, so the queue is a waiting line, not a feed.
 *
 * Same contract as `GET /inquiry`: `q`, `limit`, `offset`. Bare browse pages
 * at 100, a search at 500; the client can override either.
 */
dataops.get("/queue", async (c) => {
  const q = c.req.query("q")?.trim();
  const limit = parseInt(c.req.query("limit") ?? (q ? "500" : "100"));
  const offset = parseInt(c.req.query("offset") ?? "0");
  if (!Number.isFinite(limit) || limit < 1 || !Number.isFinite(offset) || offset < 0) {
    throw new ValidationError(["limit must be >= 1 and offset >= 0"]);
  }

  const where: SQL[] = [onDesk()!];
  if (q) where.push(buildQueueSearchPredicate(q));

  const rows = await queueSelector()
    .where(and(...where))
    // Tie-break on the key: several dossiers share one received_at when a
    // bulk drop lands, and LIMIT/OFFSET over a partial order loses rows.
    .orderBy(asc(dossier.receivedAt), asc(dossier.id))
    .limit(limit)
    .offset(offset);

  return c.json(rows);
});

/** How long the line is. The sidebar counter; never derived from a page. */
dataops.get("/queue/stats", async (c) => {
  const [row] = await db
    .select({ count: count() })
    .from(dossier)
    .where(onDesk());
  return c.json({ count: row?.count ?? 0 });
});

/**
 * One dossier, with everything a reviewer needs on screen at once: the values,
 * the evidence, and a link to the page they came from.
 */
dataops.get("/dossier/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);

  const [head] = await db.select().from(dossier).where(eq(dossier.id, id)).limit(1);
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
            model: extraction.model,
            promptVersion: extraction.promptVersion,
          })
          .from(extractionField)
          .innerJoin(extraction, eq(extraction.id, extractionField.extractionId))
          .where(inArray(extraction.artifactId, artifactIds))
          .orderBy(asc(extractionField.addressText), asc(extractionField.field))
      : [],
  ]);

  // Signed links are minted here; the browser never sees storage credentials.
  const [withLinks, entries] = await Promise.all([
    Promise.all(
      artifacts.map(async (a) => ({
        ...a,
        accessLink: await getDownloadUrl(a.storageKey, 4),
        pages: pages.filter((p) => p.artifactId === a.id),
      })),
    ),
    db.select().from(dossierEntry).where(eq(dossierEntry.dossierId, id)).orderBy(asc(dossierEntry.at), asc(dossierEntry.id)),
  ]);

  return c.json({ dossier: head, artifacts: withLinks, fields, entries });
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
 */
dataops.post("/verdict", async (c) => {
  const u = c.get("user");
  const body = await c.req.json<{
    fieldId: number;
    outcome: "confirmed" | "corrected" | "rejected";
    finalValue?: string | null;
    note?: string | null;
    reviewSeconds?: number | null;
  }>();

  if (!Number.isFinite(body.fieldId)) throw new ValidationError(["fieldId is required"]);
  if (!["confirmed", "corrected", "rejected"].includes(body.outcome)) {
    throw new ValidationError(["outcome must be confirmed, corrected or rejected"]);
  }
  if (body.outcome === "corrected" && !body.finalValue?.trim()) {
    throw new ValidationError(["a corrected verdict needs the value the reviewer put instead"]);
  }

  const [field] = await db
    .select({
      id: extractionField.id,
      field: extractionField.field,
      value: extractionField.value,
      dossierId: artifact.dossierId,
    })
    .from(extractionField)
    .innerJoin(extraction, eq(extraction.id, extractionField.extractionId))
    .innerJoin(artifact, eq(artifact.id, extraction.artifactId))
    .where(eq(extractionField.id, body.fieldId))
    .limit(1);
  if (!field) throw new NotFoundError("field not found");

  const verdictId = await db.transaction(async (tx) => {
    const [v] = await tx
      .insert(verdict)
      .values({
        extractionFieldId: body.fieldId,
        decidedBy: u.id,
        outcome: body.outcome,
        finalValue: body.finalValue ?? null,
        note: body.note ?? null,
        reviewSeconds: body.reviewSeconds ?? null,
      } as typeof verdict.$inferInsert)
      .returning({ id: verdict.id });

    await tx
      .update(extractionField)
      .set({ state: body.outcome })
      .where(eq(extractionField.id, body.fieldId));

    return v!.id;
  });

  // Same wording the 2026-09-04 backfill used, so old and new lines read alike.
  const verb =
    body.outcome === "confirmed"
      ? "Waarde overgenomen"
      : body.outcome === "corrected"
        ? "Waarde aangepast"
        : "Waarde afgekeurd";
  await addEntry({
    dossierId: field.dossierId,
    kind: "verdict",
    actorKind: "reviewer",
    actor: u.id,
    text:
      `${verb}: ${field.field} = ${body.finalValue ?? field.value ?? "—"}` +
      (body.note?.trim() ? ` — ${body.note.trim()}` : ""),
    verdictId,
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
) {
  const heads = await db
    .select({ id: dossier.id, outcome: dossier.outcome })
    .from(dossier)
    .where(inArray(dossier.id, ids));
  const missing = ids.filter((id) => !heads.some((h) => h.id === id));
  if (missing.length) throw new NotFoundError(`dossier not found: ${missing.join(", ")}`);
  const closed = heads.filter((h) => h.outcome);
  if (closed.length) {
    throw new ValidationError(closed.map((h) => `dossier ${h.id} already closed as ${h.outcome}`));
  }

  await db.transaction(async (tx) => {
    await tx
      .update(dossier)
      .set({ outcome, outcomeNote: note, outcomeAt: new Date() })
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

dataops.post("/dossier/:id/outcome", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const { outcome, note } = parseOutcome(await c.req.json());
  await closeDossiers([id], outcome, note, c.get("user").id);
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
 * Ask the melder something. The question is mailed (Resend, from
 * melding@funderdata.nl with the dossier reference in the reply address) and
 * recorded on the timeline; the melder's answer comes back through the
 * inbound webhook (routes/webhooks.ts) as a 'reply' entry.
 *
 * Unlike the courtesy mails this endpoint fails loudly: a reviewer who asks a
 * question must know whether it actually went out.
 */
dataops.post("/dossier/:id/question", async (c) => {
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const body = await c.req.json<{ text?: string }>();
  const text = body.text?.trim() ?? "";
  if (!text) throw new ValidationError(["text is required"]);
  if (text.length > 4000) throw new ValidationError(["text must be at most 4000 characters"]);

  const [head] = await db.select().from(dossier).where(eq(dossier.id, id)).limit(1);
  if (!head) throw new NotFoundError("dossier not found");
  if (head.outcome) throw new ValidationError(["dossier is closed"]);

  const sent = await sendDossierQuestionMail(head, text);
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
    visibleToMelder: true,
    mailMessageId: sent.id ?? null,
  });
  return c.json({ ok: true });
});

export default dataops;
