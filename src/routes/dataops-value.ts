import { Hono } from "hono";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dossier, dossierAddress, artifact, extraction, extractionField, verdict } from "../db/schema/dataops.ts";
import { addEntry } from "../lib/dossier-entries.ts";
import { findAddress } from "../lib/dossier-addresses.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * A value the reviewer saw and the model did not (ClientApp #340 follow-up,
 * Don's casus 2, 2026-09-15).
 *
 * Two photographs of a crawl space, the reader proposes nothing, and Ronald
 * sees a foundation on brick footings plain as day. Until now the only way to
 * record that was "Rapportage aanmaken, handmatig invullen" and typing it in
 * the sample screen -- which works for the database and says nothing to the
 * pipeline: the dossier never learns that a person found what the model
 * missed. This endpoint puts the value where every other value lives, as a
 * proposal on the dossier, confirmed by the person who typed it:
 *
 *   - one 'reviewer' extraction per dossier, hung on its first document (the
 *     schema wants an artifact; a dossier without one has nothing to add
 *     values to and is closed as no_data anyway);
 *   - an extraction_field with the value, state confirmed, evidence "door
 *     <naam> toegevoegd; niet door het model gevonden", and the address it
 *     belongs to when the reviewer picked one;
 *   - a verdict 'confirmed' so the commit takes it like any other value;
 *   - a timeline 'finding' that says a human added it -- the training signal.
 *
 * Only fields the commit knows how to land; document-level fields (soort,
 * datum, uitvoerder) have their own controls in the close panel.
 */
const routes = new Hono<AppEnv>();

/** Keys of the commit's applyField() switch: what can land on a sample. */
export const SAMPLE_FIELDS = new Set([
  "built_year", "concrete_charger_length", "crack_facade_back_type", "crack_facade_front_type",
  "crack_indoor_type", "damage_cause", "damage_characteristics", "enforcement_term", "follow_up_note",
  "foundation_depth", "foundation_quality", "foundation_type", "groundlevel", "groundwater_level",
  "pile_diameter_bottom", "pile_diameter_top", "pile_distance_length", "pile_head_level", "pile_tip_level",
  "recovery_advised", "recovery_note", "skewed_parallel", "skewed_perpendicular", "wood_encroachment",
  "wood_level", "wood_penetration_depth", "wood_type",
]);

const REVIEWER_MODEL = "reviewer";

/** The dossier's reviewer extraction, created on first use. */
async function reviewerExtraction(dossierId: number): Promise<number> {
  const [existing] = await db
    .select({ id: extraction.id })
    .from(extraction)
    .innerJoin(artifact, eq(artifact.id, extraction.artifactId))
    .where(sql`${artifact.dossierId} = ${dossierId} and ${extraction.model} = ${REVIEWER_MODEL}`)
    .limit(1);
  if (existing) return existing.id;
  const [doc] = await db
    .select({ id: artifact.id })
    .from(artifact)
    .where(eq(artifact.dossierId, dossierId))
    .orderBy(asc(artifact.id))
    .limit(1);
  if (!doc) throw new ValidationError(["dossier has no document to attach a value to"]);
  const now = new Date();
  const [row] = await db
    .insert(extraction)
    .values({ artifactId: doc.id, model: REVIEWER_MODEL, promptVersion: "manual", lane: "none", startedAt: now, finishedAt: now })
    .returning({ id: extraction.id });
  return row!.id;
}

routes.post("/dossier/:id/value", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const u = c.get("user");
  const body = await c.req.json<{ field?: string; value?: string; addressId?: string | null; note?: string | null }>();
  const field = body.field?.trim() ?? "";
  const value = body.value?.trim() ?? "";
  if (!SAMPLE_FIELDS.has(field)) throw new ValidationError([`field must be one of: ${[...SAMPLE_FIELDS].join(", ")}`]);
  if (!value) throw new ValidationError(["value is required"]);
  if (value.length > 500) throw new ValidationError(["value must be at most 500 characters"]);
  const note = body.note?.trim() || null;

  const [head] = await db.select({ id: dossier.id, outcome: dossier.outcome, inquiryId: dossier.inquiryId, buildingId: dossier.buildingId }).from(dossier).where(eq(dossier.id, id)).limit(1);
  if (!head) throw new NotFoundError("dossier not found");
  if (head.outcome || head.inquiryId) throw new ValidationError(["dossier is closed; add the value on the rapportage instead"]);

  const address = body.addressId ? await findAddress(body.addressId) : null;
  const who = u.name || u.email || u.id;
  const evidence = `Door ${who} toegevoegd; niet door het model gevonden.` + (note ? ` ${note}` : "");

  const fieldId = await db.transaction(async (tx) => {
    const extractionId = await reviewerExtraction(id);
    const [f] = await tx
      .insert(extractionField)
      .values({
        extractionId,
        field,
        value,
        confidence: null,
        evidence,
        state: "confirmed",
        addressId: address?.id ?? null,
        addressText: address?.label ?? null,
      })
      .returning({ id: extractionField.id });
    await tx.insert(verdict).values({
      extractionFieldId: f!.id,
      decidedBy: u.id,
      decidedAt: new Date(),
      outcome: "confirmed",
      finalValue: null,
      note,
    });
    // An address beyond the dossier's own pand becomes a confirmed address of
    // the dossier, as the address panel's "add" does.
    if (address && address.buildingId && address.buildingId !== head.buildingId) {
      await tx
        .insert(dossierAddress)
        .values({ dossierId: id, addressId: address.id, addressText: address.label, source: "reviewer", state: "confirmed", decidedBy: u.id, decidedAt: new Date() })
        .onConflictDoUpdate({
          target: [dossierAddress.dossierId, dossierAddress.addressId],
          set: { state: "confirmed", decidedBy: u.id, decidedAt: new Date() },
        });
    }
    return f!.id;
  });

  await addEntry({
    dossierId: id,
    kind: "finding",
    actorKind: "reviewer",
    actor: u.id,
    text: `Waarde toegevoegd door beoordelaar: ${field} = ${value}` + (address ? ` (${address.label})` : "") + " — niet door het model gevonden" + (note ? ` — ${note}` : ""),
    body: { field, value, address_id: address?.id ?? null, field_id: fieldId, human_added: true },
    visibleToMelder: false,
  });

  return c.json({ ok: true, fieldId });
});

export default routes;
