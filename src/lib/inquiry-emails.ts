// Inquiry audit-workflow emails — thin wrapper over the shared report
// templates in report-emails.ts.

import {
  type ReportEmailContext,
  sendApprovedEmail as sendApproved,
  sendRejectedEmail as sendRejected,
  sendReviewRequestedEmail as sendReviewRequested,
} from "./report-emails.ts";

export interface InquiryEmailContext {
  inquiryId: number;
  documentName: string;
  creatorEmail: string;
  creatorName: string;
  reviewerEmail: string;
  reviewerName: string;
  organizationName: string;
}

function toReport(ctx: InquiryEmailContext): ReportEmailContext {
  const { inquiryId, ...rest } = ctx;
  return { kind: "inquiry", id: inquiryId, ...rest };
}

export async function sendReviewRequestedEmail(ctx: InquiryEmailContext): Promise<void> {
  await sendReviewRequested(toReport(ctx));
}

export async function sendApprovedEmail(ctx: InquiryEmailContext): Promise<void> {
  await sendApproved(toReport(ctx));
}

export async function sendRejectedEmail(
  ctx: InquiryEmailContext & { motivation: string },
): Promise<void> {
  await sendRejected({ ...toReport(ctx), motivation: ctx.motivation });
}
