import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { inquiry, inquirySample } from "../db/schema/report.ts";
import { attribution } from "../db/schema/application.ts";
import { assertOrgPermission } from "../lib/auth-helpers.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import { intToEnum } from "../lib/inquiry-enums.ts";
import { enumArray } from "../lib/pg-enum-array.ts";
import { fromIdentifier, GeocoderDatasource } from "../lib/geocoder-id.ts";
import { toLegacyInquirySample } from "../lib/inquiry-serializer.ts";
import { filledFieldsExpression } from "../lib/sample-fields.ts";
import { activeOrgId, dataScope, loadInquiryScoped, requireWritable } from "./inquiry.ts";
import type { AppEnv } from "../types/context.ts";

const samples = new Hono<AppEnv>();

function inquiryId(c: Context<AppEnv>): number {
  const id = parseInt(c.req.param("inquiry_id") ?? "");
  if (isNaN(id)) throw new NotFoundError("Inquiry not found");
  return id;
}

async function loadSampleScoped(
  sampleId: number,
  inqId: number,
  orgIds: string[] | null,
) {
  const [hit] = await db
    .select({ s: inquirySample })
    .from(inquirySample)
    .innerJoin(inquiry, eq(inquiry.id, inquirySample.inquiry))
    .innerJoin(attribution, eq(attribution.id, inquiry.attribution))
    .where(
      and(
        eq(inquirySample.id, sampleId),
        eq(inquirySample.inquiry, inqId),
        orgIds === null ? undefined : inArray(attribution.owner, orgIds),
      ),
    )
    .limit(1);
  if (!hit) throw new NotFoundError("Inquiry sample not found");
  return hit.s;
}

// ─────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────

// Page size is capped: the row is 75 columns wide and one inquiry carries up
// to 49,753 samples (prod, 2026-09-17), so an uncapped `limit` was a way to
// ask for a 15 MB response, and `limit=abc` was a 500 from `LIMIT NaN`.
const MAX_PAGE = 1000;
function pageParams(c: Context<AppEnv>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), MAX_PAGE);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  return { limit, offset };
}

samples.get("/", async (c) => {
  const inqId = inquiryId(c);
  await loadInquiryScoped(inqId, dataScope(c)); // 404 if outside caller's scope

  const { limit, offset } = pageParams(c);

  const rows = await db
    .select()
    .from(inquirySample)
    .where(eq(inquirySample.inquiry, inqId))
    .orderBy(inquirySample.id)
    .limit(limit)
    .offset(offset);

  return c.json(rows.map(toLegacyInquirySample));
});

/**
 * What the explorer's inspector shows for a dossier without loading its
 * samples: how many addresses, how many form fields are filled across them,
 * and where they are. The Studio used to page through every sample (75
 * columns, 500 a page) and then resolve every address one geocoder call at
 * a time just to draw pins and count: 49,753 samples on the largest dossier.
 *
 * Pins are capped; a map cannot show more than a few thousand anyway, and
 * `pinsTruncated` says when it happened.
 */
const MAX_PINS = 2000;
samples.get("/summary", async (c) => {
  const inqId = inquiryId(c);
  await loadInquiryScoped(inqId, dataScope(c));

  const [[agg], pins] = await Promise.all([
    db
      .select({ count: count(), filled: sql<number>`coalesce(sum(${filledFieldsExpression()}), 0)::int` })
      .from(inquirySample)
      .where(eq(inquirySample.inquiry, inqId)),
    // Pick the samples first, then look up their buildings: joining all
    // 49,753 samples of the largest dossier before the LIMIT cost 530 ms on
    // prod, the 2,001 that survive it cost a fraction of that.
    db.execute<{ id: number; address: string; latitude: number | null; longitude: number | null }>(sql`
      select s.id, s.address,
             public.ST_Y(public.ST_Centroid(b.geom)) as latitude,
             public.ST_X(public.ST_Centroid(b.geom)) as longitude
        from (select id, address from ${inquirySample}
               where inquiry_id = ${inqId} order by id limit ${MAX_PINS + 1}) s
        join geocoder.address a on a.external_id = s.address
        left join geocoder.building b on b.external_id = a.building_id and b.active and b.geom is not null
       order by s.id`),
  ]);
  const total = Number(agg?.count ?? 0);
  const list = [...pins];
  const truncated = list.length > MAX_PINS;
  return c.json({
    count: total,
    filled: Number(agg?.filled ?? 0),
    pins: (truncated ? list.slice(0, MAX_PINS) : list)
      .filter((p) => p.latitude != null && p.longitude != null)
      .map((p) => ({ id: Number(p.id), address: p.address, latitude: Number(p.latitude), longitude: Number(p.longitude) })),
    pinsTruncated: truncated,
  });
});

samples.get("/stats", async (c) => {
  const inqId = inquiryId(c);
  await loadInquiryScoped(inqId, dataScope(c));

  const [stat] = await db
    .select({ value: count() })
    .from(inquirySample)
    .where(eq(inquirySample.inquiry, inqId));
  return c.json({ count: Number(stat?.value ?? 0) });
});

samples.get("/:sid{[0-9]+}", async (c) => {
  const inqId = inquiryId(c);
  const sid = parseInt(c.req.param("sid"));
  const row = await loadSampleScoped(sid, inqId, dataScope(c));
  return c.json(toLegacyInquirySample(row));
});

// ─────────────────────────────────────────────────────────────────────────
// Writes — body shape mirrors what ClientApp sends (camelCase, integer
// enums). Only fields known to the schema are mapped; unknown keys ignored.
// ─────────────────────────────────────────────────────────────────────────

// `address` is the input identifier (gfm-* / BAG NUMMERAANDUIDING / BAG PAND).
// The route resolves it server-side to the canonical address row and the
// resulting (id, building_id) tuple, mirroring C# `GetAddressIdAsync`. Callers
// don't need to send `building` separately — derived here.

// DB columns backed by report.length / report.height / report.diameter domains
// are numeric(5,2) — max abs 999.99. Bound zod here so out-of-range values
// surface as 400, not as a postgres "numeric field overflow" 500. Levels are
// heights on NAP (routinely negative); lengths are sizes (non-negative).
//
// NOTE: `foundationDepth` is a NAP level, not a length, despite the legacy C#
// `InquirySample.FoundationDepth` carrying `[Range(0.0, 999.99)]`. It is backed
// by the `report.height` domain, and the risk model subtracts `groundwater_level`
// from it (`recreate_model_risk_dynamic_all.sql`), which only works on a shared
// datum. The C# annotation is wrong — do not "restore" it.
const numericLevel = z.number().gte(-999.99).lte(999.99).nullish();
const numericLength = z.number().gte(0).lte(999.99).nullish();

// Entry rules ruled by Yorick 2026-08-22 after the inquiry data audit; both are
// also CHECK constraints on report.inquiry_sample, so rejecting here turns a
// postgres 23514 into a 400 with a reason.
//
// `settlementSpeed` ("zakkingssnelheid") is entered NEGATIVE: zakking = -mm/yr.
// The conventions used to be split per author and every classifier assumed
// positive, which served most measured settlements as 'nil'.
const settlementSpeed = z
  .number()
  .lte(0, "settlementSpeed: zakking wordt negatief ingevoerd (mm/jaar, <= 0)")
  .nullish();

// `builtYear` is filled only when the document states the construction year;
// otherwise it stays null and the BAG year applies. Never the document or
// import date — and a building cannot be built after today.
function isPlausibleBuiltYear(value: string): boolean {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.getUTCFullYear() >= 1000 && date.getTime() <= Date.now();
}
const builtYear = z
  .string()
  .nullish()
  .refine((v) => v == null || v === "" || isPlausibleBuiltYear(v), {
    message: "builtYear: must be a date between year 1000 and today (leave empty when the document does not state it — BAG applies)",
  });

const sampleBodySchema = z.object({
  address: z.string(),
  note: z.string().nullish(),
  builtYear,
  substructure: z.number().int().nullish(),
  cpt: z.string().nullish(),
  monitoringWell: z.string().nullish(),
  groundwaterLevelTemp: numericLevel,
  groundLevel: numericLevel,
  groundwaterLevelNet: numericLevel,
  foundationType: z.number().int().nullish(),
  enforcementTerm: z.number().int().nullish(),
  recoveryAdvised: z.boolean().nullish(),
  damageCause: z.number().int().nullish(),
  damageCharacteristics: z.number().int().nullish(),
  /** API #128: every cause, main one first. Omit to leave the list as it is. */
  damageCauses: z.array(z.number().int()).nullish(),
  /** API #128: every characteristic, main one first. Omit to leave the list as it is. */
  damageCharacteristicsList: z.array(z.number().int()).nullish(),
  constructionPile: z.number().int().nullish(),
  woodType: z.number().int().nullish(),
  woodEncroachment: z.number().int().nullish(),
  constructionLevel: numericLevel,
  woodLevel: numericLevel,
  pileDiameterTop: numericLength,
  pileDiameterBottom: numericLength,
  pileHeadLevel: numericLevel,
  pileTipLevel: numericLevel,
  foundationDepth: numericLevel,
  masonLevel: numericLevel,
  concreteChargerLength: numericLength,
  pileDistanceLength: numericLength,
  woodPenetrationDepth: numericLength,
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
  thresholdFrontLevel: numericLevel,
  thresholdBackLevel: numericLevel,
  skewedParallel: numericLength,
  skewedParallelFacade: z.number().int().nullish(),
  skewedPerpendicular: numericLength,
  skewedPerpendicularFacade: z.number().int().nullish(),
  settlementSpeed,
  skewedWindowFrame: z.boolean().nullish(),
  facadeScanRisk: z.number().int().nullish(),
});

type SampleInput = z.infer<typeof sampleBodySchema>;

// Resolve the input address identifier to the (address, building) pair the
// sample stores. The stored address key is the BAG nummeraanduiding
// (`external_id`); the gfm- address id no longer exists (Worker #158). Each
// kind of input is looked up in its own column: a nummeraanduiding in
// `external_id`, a BAG pand in `building_id` (the lowest nummeraanduiding of
// the pand; see the address↔building N:1 note). Never compare one kind with
// another column: that is how the bouwjaar lookup went dead (API #179).
async function resolveAddress(input: string): Promise<{ id: string; building: string }> {
  const raw = input.trim();
  const cleaned = raw.replaceAll(" ", "").toUpperCase();
  const ds = fromIdentifier(raw);
  const where =
    ds === GeocoderDatasource.NlBagAddress
      ? sql`a.external_id = ${cleaned}`
      : ds === GeocoderDatasource.NlBagBuilding
        ? sql`a.building_id = ${cleaned}`
        : null;
  if (!where) throw new ValidationError([`Not an address or pand id: ${input}`]);
  const rows = await db.execute(sql`
    SELECT a.external_id, a.building_id
    FROM geocoder.address a
    WHERE ${where}
    ORDER BY a.external_id
    LIMIT 1
  `);
  if (rows.length === 0) {
    throw new ValidationError([`Address not found: ${input}`]);
  }
  const row = rows[0] as { external_id: string; building_id: string };
  return { id: row.external_id, building: row.building_id };
}

// Convert validated input + resolved address → DB-shaped values
// (snake_case enum strings).
/** Ints from the wire to enum labels, in order, without duplicates or unknowns. */
function listToEnums(kind: "foundation_damage_cause" | "foundation_damage_characteristics", values: number[] | null | undefined): string[] {
  const out: string[] = [];
  for (const v of values ?? []) {
    const label = intToEnum(kind, v);
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

function toDbValues(
  input: SampleInput,
  inqId: number,
  resolved: { id: string; building: string },
) {
  return {
    inquiry: inqId,
    address: resolved.id,
    building: resolved.building,
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
    damageCharacteristics: intToEnum(
      "foundation_damage_characteristics",
      input.damageCharacteristics,
    ),
    // Only when the client sent a list: a single-value client (today's
    // Studio) leaves the list to the trigger, which replaces the old main
    // value instead of piling up corrections.
    ...(input.damageCauses !== undefined
      ? { damageCauseList: enumArray(listToEnums("foundation_damage_cause", input.damageCauses), "report.foundation_damage_cause") }
      : {}),
    ...(input.damageCharacteristicsList !== undefined
      ? {
          damageCharacteristicsList: enumArray(
            listToEnums("foundation_damage_characteristics", input.damageCharacteristicsList),
            "report.foundation_damage_characteristics",
          ),
        }
      : {}),
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
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  const { row: parent } = await loadInquiryScoped(inqId, dataScope(c));
  requireWritable(parent);

  const data = c.req.valid("json");
  const resolved = await resolveAddress(data.address);

  const created = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(inquirySample)
      .values(toDbValues(data, inqId, resolved))
      .returning();
    // Mirrors C# auto-transition: any sample creation moves inquiry to pending.
    // Only when it is not there yet: bulk entry is one write per sample, and
    // each was rewriting the inquiry row for nothing (3,867 no-op updates in
    // the 2026-08-23..09-17 prod window).
    if (parent.auditStatus !== "pending") {
      await tx
        .update(inquiry)
        .set({ auditStatus: "pending" })
        .where(eq(inquiry.id, inqId));
    }
    return s!;
  });

  return c.json(toLegacyInquirySample(created));
});

samples.put("/:sid{[0-9]+}", zValidator("json", sampleBodySchema), async (c) => {
  const orgId = activeOrgId(c);
  const inqId = inquiryId(c);
  const sid = parseInt(c.req.param("sid"));
  const u = c.get("user");
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  const { row: parent } = await loadInquiryScoped(inqId, dataScope(c));
  requireWritable(parent);
  await loadSampleScoped(sid, inqId, dataScope(c));

  const data = c.req.valid("json");
  const resolved = await resolveAddress(data.address);

  await db.transaction(async (tx) => {
    await tx
      .update(inquirySample)
      .set({ ...toDbValues(data, inqId, resolved), updateDate: new Date() })
      .where(eq(inquirySample.id, sid));
    if (parent.auditStatus !== "pending") {
      await tx
        .update(inquiry)
        .set({ auditStatus: "pending" })
        .where(eq(inquiry.id, inqId));
    }
  });

  return c.body(null, 204);
});

samples.delete("/:sid{[0-9]+}", async (c) => {
  const orgId = activeOrgId(c);
  const inqId = inquiryId(c);
  const sid = parseInt(c.req.param("sid"));
  const u = c.get("user");
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  const { row: parent } = await loadInquiryScoped(inqId, dataScope(c));
  requireWritable(parent);
  await loadSampleScoped(sid, inqId, dataScope(c));

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
