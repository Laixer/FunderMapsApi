import { Hono } from "hono";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  dossier,
  artifact,
  artifactPage,
  extraction,
  extractionField,
  verdict,
} from "../db/schema/dataops.ts";
import { getDownloadUrl } from "../lib/s3.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
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

/** States a reviewer still has to look at. */
const OPEN = ["pending", "auto_accepted", "rejected"] as const;

/**
 * The queue, oldest first.
 *
 * Oldest first is deliberate: a terugmelding carries a 24-48 hour promise to
 * the person who sent it, so the queue is a waiting line, not a feed.
 */
dataops.get("/queue", async (c) => {
  const rows = await db
    .select({
      id: dossier.id,
      channel: dossier.channel,
      subject: dossier.subject,
      externalRef: dossier.externalRef,
      receivedAt: dossier.receivedAt,
      inquiryId: dossier.inquiryId,
      open: count(extractionField.id),
    })
    .from(dossier)
    .innerJoin(artifact, eq(artifact.dossierId, dossier.id))
    .innerJoin(extraction, eq(extraction.artifactId, artifact.id))
    .innerJoin(extractionField, eq(extractionField.extractionId, extraction.id))
    .where(and(isNull(dossier.inquiryId), inArray(extractionField.state, [...OPEN])))
    .groupBy(
      dossier.id,
      dossier.channel,
      dossier.subject,
      dossier.externalRef,
      dossier.receivedAt,
      dossier.inquiryId,
    )
    .orderBy(asc(dossier.receivedAt))
    .limit(200);

  return c.json(rows);
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
            model: extraction.model,
            promptVersion: extraction.promptVersion,
          })
          .from(extractionField)
          .innerJoin(extraction, eq(extraction.id, extractionField.extractionId))
          .where(inArray(extraction.artifactId, artifactIds))
          .orderBy(asc(extractionField.field))
      : [],
  ]);

  // Signed links are minted here; the browser never sees storage credentials.
  const withLinks = await Promise.all(
    artifacts.map(async (a) => ({
      ...a,
      accessLink: await getDownloadUrl(a.storageKey, 4),
      pages: pages.filter((p) => p.artifactId === a.id),
    })),
  );

  return c.json({ dossier: head, artifacts: withLinks, fields });
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
    .select({ id: extractionField.id })
    .from(extractionField)
    .where(eq(extractionField.id, body.fieldId))
    .limit(1);
  if (!field) throw new NotFoundError("field not found");

  await db.transaction(async (tx) => {
    await tx.insert(verdict).values({
      extractionFieldId: body.fieldId,
      decidedBy: u.id,
      outcome: body.outcome,
      finalValue: body.finalValue ?? null,
      note: body.note ?? null,
      reviewSeconds: body.reviewSeconds ?? null,
    } as typeof verdict.$inferInsert);

    await tx
      .update(extractionField)
      .set({ state: body.outcome })
      .where(eq(extractionField.id, body.fieldId));
  });

  return c.json({ ok: true });
});

export default dataops;
