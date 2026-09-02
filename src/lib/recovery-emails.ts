// Recovery audit-workflow emails — thin wrapper over the shared report
// templates in report-emails.ts.

import {
  type ReportEmailContext,
  sendApprovedEmail as sendApproved,
  sendRejectedEmail as sendRejected,
  sendReviewRequestedEmail as sendReviewRequested,
} from "./report-emails.ts";

export interface RecoveryEmailContext {
  recoveryId: number;
  documentName: string;
  creatorEmail: string;
  creatorName: string;
  reviewerEmail: string;
  reviewerName: string;
  organizationName: string;
}

function toReport(ctx: RecoveryEmailContext): ReportEmailContext {
  const { recoveryId, ...rest } = ctx;
  return { kind: "recovery", id: recoveryId, ...rest };
}

export async function sendReviewRequestedEmail(ctx: RecoveryEmailContext): Promise<void> {
  await sendReviewRequested(toReport(ctx));
}

export async function sendApprovedEmail(ctx: RecoveryEmailContext): Promise<void> {
  await sendApproved(toReport(ctx));
}

export async function sendRejectedEmail(
  ctx: RecoveryEmailContext & { motivation: string },
): Promise<void> {
  await sendRejected({ ...toReport(ctx), motivation: ctx.motivation });
}
