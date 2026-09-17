import { sql, type SQL } from "drizzle-orm";
import { inquirySample } from "../db/schema/report.ts";

/**
 * The form fields of an inquiry sample, by their Drizzle property name. The
 * same 60 the Studio's `ALL_SAMPLE_FIELDS` lists (services/sampleFields.ts),
 * so "filled" means the same thing on both sides: a non-null value; `false`
 * counts, the note counts as one more when it is not empty.
 */
export const SAMPLE_FIELD_KEYS = [
  "builtYear", "substructure", "cpt", "monitoringWell", "groundLevel", "groundwaterLevelTemp", "groundwaterLevelNet",
  "recoveryAdvised", "foundationType", "enforcementTerm", "damageCause", "damageCharacteristics", "constructionPile",
  "woodType", "woodEncroachment", "constructionLevel", "woodLevel", "foundationDepth", "masonLevel", "pileDiameterTop",
  "pileDiameterBottom", "pileHeadLevel", "pileTipLevel", "concreteChargerLength", "pileDistanceLength",
  "woodPenetrationDepth", "overallQuality", "woodQuality", "constructionQuality", "woodCapacityHorizontalQuality",
  "pileWoodCapacityVerticalQuality", "carryingCapacityQuality", "masonQuality", "woodQualityNecessity",
  "crackIndoorType", "crackIndoorSize", "crackIndoorRestored", "crackFacadeFrontType", "crackFacadeFrontSize",
  "crackFacadeFrontRestored", "crackFacadeBackType", "crackFacadeBackSize", "crackFacadeBackRestored",
  "crackFacadeLeftType", "crackFacadeLeftSize", "crackFacadeLeftRestored", "crackFacadeRightType",
  "crackFacadeRightSize", "crackFacadeRightRestored", "deformedFacade", "thresholdUpdownSkewed",
  "thresholdFrontLevel", "thresholdBackLevel", "skewedParallel", "skewedParallelFacade", "skewedPerpendicular",
  "skewedPerpendicularFacade", "settlementSpeed", "skewedWindowFrame", "facadeScanRisk",
] as const satisfies readonly (keyof typeof inquirySample.$inferSelect)[];

/** `num_nonnulls(col, col, …) + (note filled)` for one sample row. */
export function filledFieldsExpression(): SQL<number> {
  const cols = SAMPLE_FIELD_KEYS.map((k) => inquirySample[k]);
  return sql<number>`(num_nonnulls(${sql.join(cols, sql`, `)}) + (case when nullif(${inquirySample.note}, '') is not null then 1 else 0 end))`;
}
