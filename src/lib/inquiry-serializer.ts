// Serialize DB rows into the C#-shaped JSON the Vue 2 ClientApp consumes.
// Mirrors FunderMaps.Core.Entities.Inquiry / InquirySample, with the same
// nested attribution/state/access/record envelopes the C# entity has.
//
// All enum-typed fields are converted from snake_case (DB) to integer (wire)
// so ClientApp's existing form lookups (statusOptions[auditStatus], etc.)
// keep working.

import type { InferSelectModel } from "drizzle-orm";
import type { inquiry, inquirySample } from "../db/schema/report.ts";
import { enumToInt, enumsToInts } from "./inquiry-enums.ts";

type InquiryRow = InferSelectModel<typeof inquiry>;
type InquirySampleRow = InferSelectModel<typeof inquirySample>;

export interface AttributionView {
  reviewer: string;
  reviewerName: string | null;
  creator: string;
  creatorName: string | null;
  owner: string;
  ownerName: string | null;
  contractor: number;
  contractorName: string | null;
}

export interface LegacyInquiry {
  id: number;
  documentName: string;
  inspection: boolean;
  jointMeasurement: boolean;
  floorMeasurement: boolean;
  note: string | null;
  documentDate: string;
  documentFile: string;
  type: number | null;
  standardF3o: boolean;
  attribution: AttributionView;
  state: { auditStatus: number };
  access: { accessPolicy: number };
  record: {
    createDate: string | null;
    updateDate: string | null;
    deleteDate: string | null;
  };
}

export function toLegacyInquiry(
  row: InquiryRow,
  attr: AttributionView,
): LegacyInquiry {
  return {
    id: row.id,
    documentName: row.documentName,
    inspection: row.inspection ?? false,
    jointMeasurement: row.jointMeasurement ?? false,
    floorMeasurement: row.floorMeasurement ?? false,
    note: row.note ?? null,
    documentDate: row.documentDate,
    documentFile: row.documentFile,
    type: enumToInt("inquiry_type", row.type),
    standardF3o: row.standardF3o ?? false,
    attribution: attr,
    state: { auditStatus: enumToInt("audit_status", row.auditStatus) ?? 0 },
    access: { accessPolicy: enumToInt("access_policy", row.accessPolicy) ?? 1 },
    record: {
      createDate: row.createDate ? row.createDate.toISOString() : null,
      updateDate: row.updateDate ? row.updateDate.toISOString() : null,
      deleteDate: row.deleteDate ? row.deleteDate.toISOString() : null,
    },
  };
}

// InquirySample is flat (no nested envelopes) but has ~40 enum-typed fields.
// Returns the C# entity shape — fields named per the C# `InquirySample` class.
export function toLegacyInquirySample(row: InquirySampleRow): Record<string, unknown> {
  return {
    id: row.id,
    inquiry: row.inquiry,
    address: row.address,
    building: row.building,
    note: row.note,
    builtYear: row.builtYear,
    substructure: enumToInt("substructure", row.substructure),
    cpt: row.cpt,
    monitoringWell: row.monitoringWell,
    groundwaterLevelTemp: row.groundwaterLevelTemp,
    groundLevel: row.groundLevel,
    groundwaterLevelNet: row.groundwaterLevelNet,
    foundationType: enumToInt("foundation_type", row.foundationType),
    enforcementTerm: enumToInt("enforcement_term", row.enforcementTerm),
    recoveryAdvised: row.recoveryAdvised,
    damageCause: enumToInt("foundation_damage_cause", row.damageCause),
    damageCharacteristics: enumsToInts(
      "foundation_damage_characteristics",
      row.damageCharacteristics,
    ),
    constructionPile: enumToInt("construction_pile", row.constructionPile),
    woodType: enumToInt("wood_type", row.woodType),
    woodEncroachment: enumToInt("wood_encroachment", row.woodEncroachment),
    constructionLevel: row.constructionLevel,
    woodLevel: row.woodLevel,
    pileDiameterTop: row.pileDiameterTop,
    pileDiameterBottom: row.pileDiameterBottom,
    pileHeadLevel: row.pileHeadLevel,
    pileTipLevel: row.pileTipLevel,
    foundationDepth: row.foundationDepth,
    masonLevel: row.masonLevel,
    concreteChargerLength: row.concreteChargerLength,
    pileDistanceLength: row.pileDistanceLength,
    woodPenetrationDepth: row.woodPenetrationDepth,
    overallQuality: enumToInt("foundation_quality", row.overallQuality),
    woodQuality: enumToInt("wood_quality", row.woodQuality),
    constructionQuality: enumToInt("quality", row.constructionQuality),
    woodCapacityHorizontalQuality: enumToInt("quality", row.woodCapacityHorizontalQuality),
    pileWoodCapacityVerticalQuality: enumToInt("quality", row.pileWoodCapacityVerticalQuality),
    carryingCapacityQuality: enumToInt("quality", row.carryingCapacityQuality),
    masonQuality: enumToInt("quality", row.masonQuality),
    woodQualityNecessity: row.woodQualityNecessity,
    crackIndoorRestored: row.crackIndoorRestored,
    crackIndoorType: enumToInt("crack_type", row.crackIndoorType),
    crackIndoorSize: row.crackIndoorSize,
    crackFacadeFrontRestored: row.crackFacadeFrontRestored,
    crackFacadeFrontType: enumToInt("crack_type", row.crackFacadeFrontType),
    crackFacadeFrontSize: row.crackFacadeFrontSize,
    crackFacadeBackRestored: row.crackFacadeBackRestored,
    crackFacadeBackType: enumToInt("crack_type", row.crackFacadeBackType),
    crackFacadeBackSize: row.crackFacadeBackSize,
    crackFacadeLeftRestored: row.crackFacadeLeftRestored,
    crackFacadeLeftType: enumToInt("crack_type", row.crackFacadeLeftType),
    crackFacadeLeftSize: row.crackFacadeLeftSize,
    crackFacadeRightRestored: row.crackFacadeRightRestored,
    crackFacadeRightType: enumToInt("crack_type", row.crackFacadeRightType),
    crackFacadeRightSize: row.crackFacadeRightSize,
    deformedFacade: row.deformedFacade,
    thresholdUpdownSkewed: row.thresholdUpdownSkewed,
    thresholdFrontLevel: row.thresholdFrontLevel,
    thresholdBackLevel: row.thresholdBackLevel,
    skewedParallel: row.skewedParallel,
    skewedParallelFacade: enumToInt("rotation_type", row.skewedParallelFacade),
    skewedPerpendicular: row.skewedPerpendicular,
    skewedPerpendicularFacade: enumToInt("rotation_type", row.skewedPerpendicularFacade),
    settlementSpeed: row.settlementSpeed,
    skewedWindowFrame: row.skewedWindowFrame,
    facadeScanRisk: enumToInt("facade_scan_risk", row.facadeScanRisk),
    createDate: row.createDate ? row.createDate.toISOString() : null,
    updateDate: row.updateDate ? row.updateDate.toISOString() : null,
    deleteDate: row.deleteDate ? row.deleteDate.toISOString() : null,
  };
}
