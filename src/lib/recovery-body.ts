// The body of POST /api/dataops/dossier/:id/recovery (Studio #341), validated
// without touching config or the database so it can be tested on its own.

// report.* enum labels, as the database spells them (lib/inquiry-enums.ts).
const DOCUMENT_TYPES = new Set(["permit", "foundation_report", "archive_report", "owner_evidence", "unknown"]);
const RECOVERY_TYPES = new Set(["table", "beam_on_pile", "pile_lowering", "pile_in_wall", "injection", "unknown"]);
const RECOVERY_STATUSES = new Set(["planned", "requested", "executed"]);
const PILE_TYPES = new Set(["press", "internally_driven", "segment"]);
const FACADES = new Set(["front", "sidewall_left", "sidewall_right", "rear"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RecoverySampleInput {
  /** The pand (NL.IMBAG.PAND.*) or one of its addresses (NL.IMBAG.NUMMERAANDUIDING.*). */
  building: string;
  type: string;
  status?: string | null;
  pileType?: string | null;
  facade?: string[] | null;
  recoveryDate?: string | null;
  permit?: string | null;
  permitDate?: string | null;
  note?: string | null;
}

export interface RecoveryBody {
  documentType: string;
  documentDate: string;
  contractor?: number | null;
  note?: string | null;
  samples: RecoverySampleInput[];
}

/** Every problem with the body at once, the way the Studio can show them. */
export function validateRecoveryBody(body: Partial<RecoveryBody>): string[] {
  const errors: string[] = [];
  if (!body.documentType || !DOCUMENT_TYPES.has(body.documentType)) errors.push(`documentType must be one of ${[...DOCUMENT_TYPES].join(", ")}`);
  if (!body.documentDate || !DATE.test(body.documentDate)) errors.push("documentDate must be YYYY-MM-DD");
  if (body.contractor != null && (!Number.isInteger(body.contractor) || body.contractor <= 0)) errors.push("contractor must be a contractor id");
  if (!Array.isArray(body.samples) || body.samples.length === 0) errors.push("at least one pand (samples[]) is required");
  (body.samples ?? []).forEach((s, i) => {
    const at = `samples[${i}]`;
    if (!s?.building) errors.push(`${at}.building is required`);
    if (!s?.type || !RECOVERY_TYPES.has(s.type)) errors.push(`${at}.type must be one of ${[...RECOVERY_TYPES].join(", ")}`);
    if (s?.status != null && !RECOVERY_STATUSES.has(s.status)) errors.push(`${at}.status must be one of ${[...RECOVERY_STATUSES].join(", ")}`);
    if (s?.pileType != null && !PILE_TYPES.has(s.pileType)) errors.push(`${at}.pileType must be one of ${[...PILE_TYPES].join(", ")}`);
    if (s?.facade != null && (!Array.isArray(s.facade) || s.facade.some((f) => !FACADES.has(f)))) errors.push(`${at}.facade must be a list of ${[...FACADES].join(", ")}`);
    for (const k of ["recoveryDate", "permitDate"] as const) if (s?.[k] != null && !DATE.test(s[k]!)) errors.push(`${at}.${k} must be YYYY-MM-DD`);
  });
  return errors;
}
