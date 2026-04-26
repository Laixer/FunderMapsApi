import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { inquiry, inquirySample } from "../db/schema/report.ts";
import { attribution } from "../db/schema/application.ts";
import { assertCanWrite } from "../lib/auth-helpers.ts";
import { NotFoundError } from "../lib/errors.ts";
import { intToEnum, intsToEnums } from "../lib/inquiry-enums.ts";
import { toLegacyInquirySample } from "../lib/inquiry-serializer.ts";
import { activeOrgId, loadInquiryScoped, requireWritable } from "./inquiry.ts";
import type { AppEnv } from "../types/context.ts";

const samples = new Hono<AppEnv>();

function inquiryId(c: Context<AppEnv>): number {
  const id = parseInt(c.req.param("inquiry_id"));
  if (isNaN(id)) throw new NotFoundError("Inquiry not found");
  return id;
}

async function loadSampleScoped(sampleId: number, inqId: number, orgId: string) {
  const [hit] = await db
    .select({ s: inquirySample })
    .from(inquirySample)
    .innerJoin(inquiry, eq(inquiry.id, inquirySample.inquiry))
    .innerJoin(attribution, eq(attribution.id, inquiry.attribution))
    .where(
      and(
        eq(inquirySample.id, sampleId),
        eq(inquirySample.inquiry, inqId),
        eq(attribution.owner, orgId),
      ),
    )
    .limit(1);
  if (!hit) throw new NotFoundError("Inquiry sample not found");
  return hit.s;
}

// ─────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────

samples.get("/", async (c) => {
  const orgId = activeOrgId(c);
  const inqId = inquiryId(c);
  await loadInquiryScoped(inqId, orgId); // 404 if not in caller's org

  const limit = parseInt(c.req.query("limit") ?? "100");
  const offset = parseInt(c.req.query("offset") ?? "0");

  const rows = await db
    .select()
    .from(inquirySample)
    .where(eq(inquirySample.inquiry, inqId))
    .orderBy(inquirySample.id)
    .limit(limit)
    .offset(offset);

  return c.json(rows.map(toLegacyInquirySample));
});

samples.get("/stats", async (c) => {
  const orgId = activeOrgId(c);
  const inqId = inquiryId(c);
  await loadInquiryScoped(inqId, orgId);

  const [stat] = await db
    .select({ value: count() })
    .from(inquirySample)
    .where(eq(inquirySample.inquiry, inqId));
  return c.json({ count: Number(stat?.value ?? 0) });
});

samples.get("/:sid{[0-9]+}", async (c) => {
  const orgId = activeOrgId(c);
  const inqId = inquiryId(c);
  const sid = parseInt(c.req.param("sid"));
  const row = await loadSampleScoped(sid, inqId, orgId);
  return c.json(toLegacyInquirySample(row));
});

// ─────────────────────────────────────────────────────────────────────────
// Writes — body shape mirrors what ClientApp sends (camelCase, integer
// enums). Only fields known to the schema are mapped; unknown keys ignored.
// ─────────────────────────────────────────────────────────────────────────

const sampleBodySchema = z.object({
  address: z.string().optional(),
  building: z.string(),
  note: z.string().nullish(),
  builtYear: z.string().nullish(),
  substructure: z.number().int().nullish(),
  cpt: z.string().nullish(),
  monitoringWell: z.string().nullish(),
  groundwaterLevelTemp: z.number().nullish(),
  groundLevel: z.number().nullish(),
  groundwaterLevelNet: z.number().nullish(),
  foundationType: z.number().int().nullish(),
  enforcementTerm: z.number().int().nullish(),
  recoveryAdvised: z.boolean().nullish(),
  damageCause: z.number().int().nullish(),
  damageCharacteristics: z.array(z.number().int()).nullish(),
  constructionPile: z.number().int().nullish(),
  woodType: z.number().int().nullish(),
  woodEncroachment: z.number().int().nullish(),
  constructionLevel: z.number().nullish(),
  woodLevel: z.number().nullish(),
  pileDiameterTop: z.number().nullish(),
  pileDiameterBottom: z.number().nullish(),
  pileHeadLevel: z.number().nullish(),
  pileTipLevel: z.number().nullish(),
  foundationDepth: z.number().nullish(),
  masonLevel: z.number().nullish(),
  concreteChargerLength: z.number().nullish(),
  pileDistanceLength: z.number().nullish(),
  woodPenetrationDepth: z.number().nullish(),
  overallQuality: z.number().int().nullish(),
  woodQuality: z.number().int().nullish(),
  constructionQuality: z.number().int().nullish(),
  woodCapacityHorizontalQuality: z.number().int().nullish(),
  pileWoodCapacityVerticalQuality: z.number().int().nullish(),
  carryingCapacityQuality: z.number().int().nullish(),
  masonQuality: z.number().int().nullish(),
  woodQualityNecessity: z.boolean().nullish(),
  crackIndoorRestored: z.boolean().nullish(),
  crackIndoorType: z.number().int().nullish(),
  crackIndoorSize: z.number().int().nullish(),
  crackFacadeFrontRestored: z.boolean().nullish(),
  crackFacadeFrontType: z.number().int().nullish(),
  crackFacadeFrontSize: z.number().int().nullish(),
  crackFacadeBackRestored: z.boolean().nullish(),
  crackFacadeBackType: z.number().int().nullish(),
  crackFacadeBackSize: z.number().int().nullish(),
  crackFacadeLeftRestored: z.boolean().nullish(),
  crackFacadeLeftType: z.number().int().nullish(),
  crackFacadeLeftSize: z.number().int().nullish(),
  crackFacadeRightRestored: z.boolean().nullish(),
  crackFacadeRightType: z.number().int().nullish(),
  crackFacadeRightSize: z.number().int().nullish(),
  deformedFacade: z.boolean().nullish(),
  thresholdUpdownSkewed: z.boolean().nullish(),
  thresholdFrontLevel: z.number().nullish(),
  thresholdBackLevel: z.number().nullish(),
  skewedParallel: z.number().nullish(),
  skewedParallelFacade: z.number().int().nullish(),
  skewedPerpendicular: z.number().nullish(),
  skewedPerpendicularFacade: z.number().int().nullish(),
  settlementSpeed: z.number().nullish(),
  skewedWindowFrame: z.boolean().nullish(),
  facadeScanRisk: z.number().int().nullish(),
});

type SampleInput = z.infer<typeof sampleBodySchema>;

// Convert validated input → DB-shaped values (snake_case enum strings).
function toDbValues(input: SampleInput, inqId: number) {
  return {
    inquiry: inqId,
    address: input.address ?? null,
    building: input.building,
    note: input.note?.trim() || null,
    builtYear: input.builtYear ?? null,
    substructure: intToEnum("substructure", input.substructure),
    cpt: input.cpt ?? null,
    monitoringWell: input.monitoringWell ?? null,
    groundwaterLevelTemp: input.groundwaterLevelTemp ?? null,
    groundLevel: input.groundLevel ?? null,
    groundwaterLevelNet: input.groundwaterLevelNet ?? null,
    foundationType: intToEnum("foundation_type", input.foundationType),
    enforcementTerm: intToEnum("enforcement_term", input.enforcementTerm),
    recoveryAdvised: input.recoveryAdvised ?? null,
    damageCause: intToEnum("foundation_damage_cause", input.damageCause),
    damageCharacteristics: intsToEnums("foundation_damage_characteristics", input.damageCharacteristics ?? null),
    constructionPile: intToEnum("construction_pile", input.constructionPile),
    woodType: intToEnum("wood_type", input.woodType),
    woodEncroachment: intToEnum("wood_encroachment", input.woodEncroachment),
    constructionLevel: input.constructionLevel ?? null,
    woodLevel: input.woodLevel ?? null,
    pileDiameterTop: input.pileDiameterTop ?? null,
    pileDiameterBottom: input.pileDiameterBottom ?? null,
    pileHeadLevel: input.pileHeadLevel ?? null,
    pileTipLevel: input.pileTipLevel ?? null,
    foundationDepth: input.foundationDepth ?? null,
    masonLevel: input.masonLevel ?? null,
    concreteChargerLength: input.concreteChargerLength ?? null,
    pileDistanceLength: input.pileDistanceLength ?? null,
    woodPenetrationDepth: input.woodPenetrationDepth ?? null,
    overallQuality: intToEnum("foundation_quality", input.overallQuality),
    woodQuality: intToEnum("wood_quality", input.woodQuality),
    constructionQuality: intToEnum("quality", input.constructionQuality),
    woodCapacityHorizontalQuality: intToEnum("quality", input.woodCapacityHorizontalQuality),
    pileWoodCapacityVerticalQuality: intToEnum("quality", input.pileWoodCapacityVerticalQuality),
    carryingCapacityQuality: intToEnum("quality", input.carryingCapacityQuality),
    masonQuality: intToEnum("quality", input.masonQuality),
    woodQualityNecessity: input.woodQualityNecessity ?? null,
    crackIndoorRestored: input.crackIndoorRestored ?? null,
    crackIndoorType: intToEnum("crack_type", input.crackIndoorType),
    crackIndoorSize: input.crackIndoorSize ?? null,
    crackFacadeFrontRestored: input.crackFacadeFrontRestored ?? null,
    crackFacadeFrontType: intToEnum("crack_type", input.crackFacadeFrontType),
    crackFacadeFrontSize: input.crackFacadeFrontSize ?? null,
    crackFacadeBackRestored: input.crackFacadeBackRestored ?? null,
    crackFacadeBackType: intToEnum("crack_type", input.crackFacadeBackType),
    crackFacadeBackSize: input.crackFacadeBackSize ?? null,
    crackFacadeLeftRestored: input.crackFacadeLeftRestored ?? null,
    crackFacadeLeftType: intToEnum("crack_type", input.crackFacadeLeftType),
    crackFacadeLeftSize: input.crackFacadeLeftSize ?? null,
    crackFacadeRightRestored: input.crackFacadeRightRestored ?? null,
    crackFacadeRightType: intToEnum("crack_type", input.crackFacadeRightType),
    crackFacadeRightSize: input.crackFacadeRightSize ?? null,
    deformedFacade: input.deformedFacade ?? null,
    thresholdUpdownSkewed: input.thresholdUpdownSkewed ?? null,
    thresholdFrontLevel: input.thresholdFrontLevel ?? null,
    thresholdBackLevel: input.thresholdBackLevel ?? null,
    skewedParallel: input.skewedParallel ?? null,
    skewedParallelFacade: intToEnum("rotation_type", input.skewedParallelFacade),
    skewedPerpendicular: input.skewedPerpendicular ?? null,
    skewedPerpendicularFacade: intToEnum("rotation_type", input.skewedPerpendicularFacade),
    settlementSpeed: input.settlementSpeed ?? null,
    skewedWindowFrame: input.skewedWindowFrame ?? null,
    facadeScanRisk: intToEnum("facade_scan_risk", input.facadeScanRisk),
  };
}

samples.post("/", zValidator("json", sampleBodySchema), async (c) => {
  const orgId = activeOrgId(c);
  const inqId = inquiryId(c);
  const u = c.get("user");
  await assertCanWrite(u.id, orgId);

  const { row: parent } = await loadInquiryScoped(inqId, orgId);
  requireWritable(parent);

  const data = c.req.valid("json");

  const created = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(inquirySample)
      .values(toDbValues(data, inqId))
      .returning();
    // Mirrors C# auto-transition: any sample creation moves inquiry to pending.
    await tx
      .update(inquiry)
      .set({ auditStatus: "pending" })
      .where(eq(inquiry.id, inqId));
    return s!;
  });

  return c.json(toLegacyInquirySample(created));
});

samples.put("/:sid{[0-9]+}", zValidator("json", sampleBodySchema), async (c) => {
  const orgId = activeOrgId(c);
  const inqId = inquiryId(c);
  const sid = parseInt(c.req.param("sid"));
  const u = c.get("user");
  await assertCanWrite(u.id, orgId);

  const { row: parent } = await loadInquiryScoped(inqId, orgId);
  requireWritable(parent);
  await loadSampleScoped(sid, inqId, orgId);

  const data = c.req.valid("json");

  await db.transaction(async (tx) => {
    await tx
      .update(inquirySample)
      .set({ ...toDbValues(data, inqId), updateDate: new Date() })
      .where(eq(inquirySample.id, sid));
    await tx
      .update(inquiry)
      .set({ auditStatus: "pending" })
      .where(eq(inquiry.id, inqId));
  });

  return c.body(null, 204);
});

samples.delete("/:sid{[0-9]+}", async (c) => {
  const orgId = activeOrgId(c);
  const inqId = inquiryId(c);
  const sid = parseInt(c.req.param("sid"));
  const u = c.get("user");
  await assertCanWrite(u.id, orgId);

  const { row: parent } = await loadInquiryScoped(inqId, orgId);
  requireWritable(parent);
  await loadSampleScoped(sid, inqId, orgId);

  await db.transaction(async (tx) => {
    await tx.delete(inquirySample).where(eq(inquirySample.id, sid));
    // C# behavior: when last sample disappears, inquiry transitions back
    // to todo. transitionToTodo only allowed from pending — we mirror that.
    const [c2] = await tx
      .select({ remaining: count() })
      .from(inquirySample)
      .where(eq(inquirySample.inquiry, inqId));
    if (Number(c2?.remaining ?? 0) === 0 && parent.auditStatus === "pending") {
      await tx
        .update(inquiry)
        .set({ auditStatus: "todo" })
        .where(eq(inquiry.id, inqId));
    }
  });

  return c.body(null, 204);
});

export default samples;
