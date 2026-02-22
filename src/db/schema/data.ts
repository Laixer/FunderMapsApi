import { pgSchema, text, integer, real } from "drizzle-orm/pg-core";

export const dataSchema = pgSchema("data");

// This is a view, used for SELECT only
export const modelRiskStatic = dataSchema.table("model_risk_static", {
  buildingId: text("building_id"),
  neighborhoodId: text("neighborhood_id"),
  constructionYear: integer("construction_year"),
  constructionYearReliability: text("construction_year_reliability"),
  recoveryType: text("recovery_type"),
  restorationCosts: real("restoration_costs"),
  height: real(),
  velocity: real(),
  groundWaterLevel: real("ground_water_level"),
  groundLevel: real("ground_level"),
  soil: text(),
  surfaceArea: real("surface_area"),
  damageCause: text("damage_cause"),
  enforcementTerm: text("enforcement_term"),
  overallQuality: text("overall_quality"),
  inquiryType: text("inquiry_type"),
  foundationType: text("foundation_type"),
  foundationTypeReliability: text("foundation_type_reliability"),
  drystand: real(),
  drystandReliability: text("drystand_reliability"),
  drystandRisk: text("drystand_risk"),
  dewateringDepth: real("dewatering_depth"),
  dewateringDepthReliability: text("dewatering_depth_reliability"),
  dewateringDepthRisk: text("dewatering_depth_risk"),
  bioInfectionReliability: text("bio_infection_reliability"),
  bioInfectionRisk: text("bio_infection_risk"),
  unclassifiedRisk: text("unclassified_risk"),
});
