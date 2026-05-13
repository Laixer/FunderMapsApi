// Inquiry audit-workflow emails. Mirrors C# InquiryController + Mailgun
// templates `report-reviewer`, `report-declined`, `report-approved`. The
// template variables (id, creatorName, organizationName, reviewerName,
// documentName, motivation) must match the names baked into the Mailgun
// template HTML — do not rename without updating Mailgun.

import { sendMail } from "../services/mail.ts";

const FROM = "FunderMaps <noreply@fundermaps.com>";

export interface InquiryEmailContext {
  inquiryId: number;
  documentName: string;
  creatorEmail: string;
  creatorName: string;
  reviewerEmail: string;
  reviewerName: string;
  organizationName: string;
}

function recipient(email: string, name: string): string {
  return name ? `${name} <${email}>` : email;
}

export async function sendReviewRequestedEmail(
  ctx: InquiryEmailContext,
): Promise<void> {
  await sendMail({
    from: FROM,
    to: [recipient(ctx.reviewerEmail, ctx.reviewerName)],
    subject: "FunderMaps - Rapportage ter review",
    template: "report-reviewer",
    variables: {
      id: ctx.inquiryId,
      creatorName: ctx.creatorName,
      organizationName: ctx.organizationName,
      reviewerName: ctx.reviewerName,
      documentName: ctx.documentName,
    },
  });
}

export async function sendApprovedEmail(
  ctx: InquiryEmailContext,
): Promise<void> {
  await sendMail({
    from: FROM,
    to: [
      recipient(ctx.creatorEmail, ctx.creatorName),
      recipient(ctx.reviewerEmail, ctx.reviewerName),
    ],
    subject: "FunderMaps - Rapportage is goedgekeurd",
    template: "report-approved",
    variables: {
      id: ctx.inquiryId,
      reviewerName: ctx.reviewerName,
      documentName: ctx.documentName,
    },
  });
}

export async function sendRejectedEmail(
  ctx: InquiryEmailContext & { motivation: string },
): Promise<void> {
  await sendMail({
    from: FROM,
    to: [
      recipient(ctx.creatorEmail, ctx.creatorName),
      recipient(ctx.reviewerEmail, ctx.reviewerName),
    ],
    subject: "FunderMaps - Rapportage is afgekeurd",
    template: "report-declined",
    variables: {
      id: ctx.inquiryId,
      reviewerName: ctx.reviewerName,
      documentName: ctx.documentName,
      motivation: ctx.motivation,
    },
  });
}
