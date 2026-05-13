// Recovery audit-workflow emails. The C# RecoveryController reuses the same
// Mailgun templates (`report-reviewer`, `report-declined`, `report-approved`)
// as inquiry — the templates are generic enough that the only field
// difference is `id` semantics (recovery vs inquiry row id, both ints).

import { sendMail } from "../services/mail.ts";

const FROM = "FunderMaps <noreply@fundermaps.com>";

export interface RecoveryEmailContext {
  recoveryId: number;
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
  ctx: RecoveryEmailContext,
): Promise<void> {
  await sendMail({
    from: FROM,
    to: [recipient(ctx.reviewerEmail, ctx.reviewerName)],
    subject: "FunderMaps - Rapportage ter review",
    template: "report-reviewer",
    variables: {
      id: ctx.recoveryId,
      creatorName: ctx.creatorName,
      organizationName: ctx.organizationName,
      reviewerName: ctx.reviewerName,
      documentName: ctx.documentName,
    },
  });
}

export async function sendApprovedEmail(
  ctx: RecoveryEmailContext,
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
      id: ctx.recoveryId,
      reviewerName: ctx.reviewerName,
      documentName: ctx.documentName,
    },
  });
}

export async function sendRejectedEmail(
  ctx: RecoveryEmailContext & { motivation: string },
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
      id: ctx.recoveryId,
      reviewerName: ctx.reviewerName,
      documentName: ctx.documentName,
      motivation: ctx.motivation,
    },
  });
}
