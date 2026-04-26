import {
  pgSchema,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  date,
  real,
  serial,
} from "drizzle-orm/pg-core";
import { attribution } from "./application.ts";

export const reportSchema = pgSchema("report");

// Declared so Drizzle/postgres.js serialize damageCharacteristics arrays
// with the correct PG type tag — otherwise the enum-array column rejects
// the text-literal fallback.
export const foundationDamageCharacteristicsEnum = reportSchema.enum(
  "foundation_damage_characteristics",
  [
    "jamming_door_window",
    "crack",
    "skewed",
    "crawlspace_flooding",
    "threshold_above_subsurface",
    "threshold_below_subsurface",
    "crooked_floor_wall",
  ],
);

export const incident = reportSchema.table("incident", {
  id: text().primaryKey(),
  foundationType: text("foundation_type"),
  chainedBuilding: boolean("chained_building").default(false),
  owner: boolean().default(false),
  foundationRecovery: boolean("foundation_recovery").default(false),
  neighborRecovery: boolean("neighbor_recovery").default(false),
  foundationDamageCause: text("foundation_damage_cause"),
  fileResourceKey: text("file_resource_key"),
  documentFile: text("document_file").array(),
  note: text(),
  contact: text().notNull(),
  contactName: text("contact_name"),
  contactPhoneNumber: text("contact_phone_number"),
  environmentDamageCharacteristics: text(
    "environment_damage_characteristics",
  ).array(),
  foundationDamageCharacteristics: text(
    "foundation_damage_characteristics",
  ).array(),
  building: text("building_id").notNull(),
  metadata: jsonb().$type<Record<string, unknown>>(),
});

export const inquiry = reportSchema.table("inquiry", {
  id: serial().primaryKey(),
  documentName: text("document_name").notNull(),
  inspection: boolean().default(false),
  jointMeasurement: boolean("joint_measurement").default(false),
  floorMeasurement: boolean("floor_measurement").default(false),
  createDate: timestamp("create_date").defaultNow(),
  updateDate: timestamp("update_date"),
  deleteDate: timestamp("delete_date"),
  note: text(),
  documentDate: date("document_date").notNull(),
  documentFile: text("document_file").notNull(),
  attribution: integer("attribution_id")
    .notNull()
    .references(() => attribution.id),
  accessPolicy: text("access_policy").default("private"),
  type: text().notNull(),
  standardF3o: boolean("standard_f3o").default(false),
  auditStatus: text("audit_status").default("todo"),
});

export const inquirySample = reportSchema.table("inquiry_sample", {
  id: serial().primaryKey(),
  inquiry: integer("inquiry_id")
    .notNull()
    .references(() => inquiry.id),
  address: text(),
  createDate: timestamp("create_date").defaultNow(),
  updateDate: timestamp("update_date"),
  deleteDate: timestamp("delete_date"),
  note: text(),
  builtYear: date("built_year"),
  substructure: text(),
  overallQuality: text("overall_quality"),
  woodQuality: text("wood_quality"),
  constructionQuality: text("construction_quality"),
  woodCapacityHorizontalQuality: text("wood_capacity_horizontal_quality"),
  pileWoodCapacityVerticalQuality: text("pile_wood_capacity_vertical_quality"),
  carryingCapacityQuality: text("carrying_capacity_quality"),
  masonQuality: text("mason_quality"),
  woodQualityNecessity: boolean("wood_quality_necessity"),
  constructionLevel: real("construction_level"),
  woodLevel: real("wood_level"),
  pileDiameterTop: real("pile_diameter_top"),
  pileDiameterBottom: real("pile_diameter_bottom"),
  pileHeadLevel: real("pile_head_level"),
  pileTipLevel: real("pile_tip_level"),
  foundationDepth: real("foundation_depth"),
  masonLevel: real("mason_level"),
  concreteChargerLength: real("concrete_charger_length"),
  pileDistanceLength: real("pile_distance_length"),
  woodPenetrationDepth: real("wood_penetration_depth"),
  cpt: text(),
  monitoringWell: text("monitoring_well"),
  groundwaterLevelTemp: real("groundwater_level_temp"),
  groundLevel: real("groundlevel"),
  groundwaterLevelNet: real("groundwater_level_net"),
  foundationType: text("foundation_type"),
  enforcementTerm: text("enforcement_term"),
  recoveryAdvised: boolean("recovery_advised"),
  damageCause: text("damage_cause"),
  damageCharacteristics: foundationDamageCharacteristicsEnum(
    "damage_characteristics",
  ).array(),
  constructionPile: text("construction_pile"),
  woodType: text("wood_type"),
  woodEncroachment: text("wood_encroachment"),
  crackIndoorRestored: boolean("crack_indoor_restored"),
  crackIndoorType: text("crack_indoor_type"),
  crackIndoorSize: integer("crack_indoor_size"),
  crackFacadeFrontRestored: boolean("crack_facade_front_restored"),
  crackFacadeFrontType: text("crack_facade_front_type"),
  crackFacadeFrontSize: integer("crack_facade_front_size"),
  crackFacadeBackRestored: boolean("crack_facade_back_restored"),
  crackFacadeBackType: text("crack_facade_back_type"),
  crackFacadeBackSize: integer("crack_facade_back_size"),
  crackFacadeLeftRestored: boolean("crack_facade_left_restored"),
  crackFacadeLeftType: text("crack_facade_left_type"),
  crackFacadeLeftSize: integer("crack_facade_left_size"),
  crackFacadeRightRestored: boolean("crack_facade_right_restored"),
  crackFacadeRightType: text("crack_facade_right_type"),
  crackFacadeRightSize: integer("crack_facade_right_size"),
  deformedFacade: boolean("deformed_facade"),
  thresholdUpdownSkewed: boolean("threshold_updown_skewed"),
  thresholdFrontLevel: real("threshold_front_level"),
  thresholdBackLevel: real("threshold_back_level"),
  skewedParallel: real("skewed_parallel"),
  skewedPerpendicular: real("skewed_perpendicular"),
  skewedParallelFacade: text("skewed_parallel_facade"),
  settlementSpeed: real("settlement_speed"),
  skewedWindowFrame: boolean("skewed_window_frame"),
  skewedPerpendicularFacade: text("skewed_perpendicular_facade"),
  building: text("building_id").notNull(),
  facadeScanRisk: text("facade_scan_risk"),
  metadata: jsonb().$type<Record<string, unknown>>(),
});

export const recovery = reportSchema.table("recovery", {
  id: serial().primaryKey(),
  createDate: timestamp("create_date").defaultNow(),
  updateDate: timestamp("update_date"),
  deleteDate: timestamp("delete_date"),
  note: text(),
  attribution: integer("attribution_id")
    .notNull()
    .references(() => attribution.id),
  accessPolicy: text("access_policy").default("private"),
  type: text().default("unknown"),
  documentDate: date("document_date").notNull(),
  documentFile: text("document_file").notNull(),
  auditStatus: text("audit_status").default("todo"),
  documentName: text("document_name").notNull(),
});

export const recoverySample = reportSchema.table("recovery_sample", {
  id: serial().primaryKey(),
  recovery: integer("recovery_id")
    .notNull()
    .references(() => recovery.id),
  createDate: timestamp("create_date").defaultNow(),
  updateDate: timestamp("update_date"),
  deleteDate: timestamp("delete_date"),
  note: text(),
  status: text(),
  type: text().default("unknown"),
  pileType: text("pile_type"),
  facade: text().array(),
  permit: text(),
  permitDate: timestamp("permit_date"),
  recoveryDate: timestamp("recovery_date"),
  contractor: integer("contractor_id"),
  buildingId: text("building_id").notNull(),
  metadata: jsonb().$type<Record<string, unknown>>(),
});
