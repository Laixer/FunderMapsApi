// Serialize DB rows for recovery into the C#-shaped JSON the ClientApp consumes.
// Mirrors FunderMaps.Core.Entities.Recovery / RecoverySample with the same
// nested attribution/state/access/record envelopes the C# entity has.
//
// Enum-typed fields are converted from snake_case (DB) to integer (wire) so
// ClientApp's lookup tables (statusOptions[auditStatus], etc.) keep working.

import type { InferSelectModel } from "drizzle-orm";
import type { recovery, recoverySample } from "../db/schema/report.ts";
import type { AttributionView } from "./inquiry-serializer.ts";
import { enumToInt, enumsToInts } from "./inquiry-enums.ts";

type RecoveryRow = InferSelectModel<typeof recovery>;
type RecoverySampleRow = InferSelectModel<typeof recoverySample>;

export interface LegacyRecovery {
  id: number;
  documentName: string;
  note: string | null;
  documentDate: string;
  documentFile: string;
  type: number | null;
  attribution: AttributionView;
  state: { auditStatus: number };
  access: { accessPolicy: number };
  record: {
    createDate: string | null;
    updateDate: string | null;
    deleteDate: string | null;
  };
}

export function toLegacyRecovery(
  row: RecoveryRow,
  attr: AttributionView,
): LegacyRecovery {
  return {
    id: row.id,
    documentName: row.documentName,
    note: row.note ?? null,
    documentDate: row.documentDate,
    documentFile: row.documentFile,
    type: enumToInt("recovery_document_type", row.type),
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

export function toLegacyRecoverySample(row: RecoverySampleRow): Record<string, unknown> {
  return {
    id: row.id,
    recovery: row.recovery,
    building: row.buildingId,
    note: row.note,
    status: enumToInt("recovery_status", row.status),
    type: enumToInt("recovery_type", row.type),
    pileType: enumToInt("pile_type", row.pileType),
    facade: enumsToInts("facade", row.facade),
    permit: row.permit,
    permitDate: row.permitDate,
    recoveryDate: row.recoveryDate,
    contractor: row.contractor,
    createDate: row.createDate ? row.createDate.toISOString() : null,
    updateDate: row.updateDate ? row.updateDate.toISOString() : null,
    deleteDate: row.deleteDate ? row.deleteDate.toISOString() : null,
  };
}
