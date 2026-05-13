// No-op stubs for the recovery status-transition emails the C# WebApi sends
// via Mailgun. Parallel to inquiry-emails.ts — single place to wire later.
// Mirrors C# templates `report-reviewer`, `report-declined`, `report-approved`
// (same templates as inquiry; the C# RecoveryController reuses them).

export interface RecoveryEmailContext {
  recoveryId: number;
  documentName: string;
  creatorEmail: string;
  creatorName: string;
  reviewerEmail: string;
  reviewerName: string;
  organizationName: string;
}

export async function sendReviewRequestedEmail(
  _ctx: RecoveryEmailContext,
): Promise<void> {
  // intentionally no-op — wire when product wants email back
}

export async function sendApprovedEmail(
  _ctx: RecoveryEmailContext,
): Promise<void> {
  // intentionally no-op
}

export async function sendRejectedEmail(
  _ctx: RecoveryEmailContext & { motivation: string },
): Promise<void> {
  // intentionally no-op
}
