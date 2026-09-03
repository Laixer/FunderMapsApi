// Audit-workflow notification emails shared by inquiries and recoveries.
// These used to be three Mailgun-hosted templates (report-reviewer,
// report-approved, report-declined); the HTML went down with the Mailgun
// account, so the copy lives here now. Plain text is the canonical body, the
// HTML is a light wrapper around the same words.

import { inArray } from "drizzle-orm";
import { env } from "../config.ts";
import { db } from "../db/client.ts";
import { user } from "../db/schema/application.ts";
import { sendMail } from "../services/mail.ts";

export type ReportKind = "inquiry" | "recovery";

export interface ReportEmailContext {
  kind: ReportKind;
  id: number;
  documentName: string;
  creatorEmail: string;
  creatorName: string;
  reviewerEmail: string;
  reviewerName: string;
  organizationName: string;
}

// Resolve creator/reviewer user ids to addresses. Attribution only carries
// ids + display names; the address has to come from application.user.
export async function lookupUserEmails(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(inArray(user.id, unique));
  return new Map(rows.map((r) => [r.id, r.email]));
}

const KIND_LABEL: Record<ReportKind, string> = {
  inquiry: "onderzoeksrapport",
  recovery: "herstelrapport",
};

// Attribution rows can point at users without a resolvable address (deleted
// accounts, #973 backfill placeholders). Drop those rather than sending an
// invalid "to" that fails the whole call.
function recipients(...pairs: [email: string, name: string][]): string[] {
  return pairs
    .filter(([email]) => email.includes("@"))
    .map(([email, name]) => (name ? `${name} <${email}>` : email));
}

function reportUrl(ctx: ReportEmailContext): string {
  return `${env.STUDIO_URL}/${ctx.kind}/${ctx.id}`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Wrap a list of paragraphs (plain strings; the URL is linked automatically)
// into both bodies. Keeps the two renderings from drifting apart.
function render(paragraphs: string[], url: string): { text: string; html: string } {
  const text = [...paragraphs, url, "", "Met vriendelijke groet,", "FunderMaps"].join("\n\n");
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">` +
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
    `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` +
    `<p>Met vriendelijke groet,<br>FunderMaps</p>` +
    `</div>`;
  return { text, html };
}

export async function sendReviewRequestedEmail(ctx: ReportEmailContext): Promise<void> {
  const url = reportUrl(ctx);
  const body = render(
    [
      `Beste ${ctx.reviewerName || "reviewer"},`,
      `${ctx.creatorName} (${ctx.organizationName}) heeft het ${KIND_LABEL[ctx.kind]} "${ctx.documentName}" ter review aangeboden.`,
      `Open het rapport in FunderMaps Data Studio om het te beoordelen:`,
    ],
    url,
  );
  await sendMail({
    to: recipients([ctx.reviewerEmail, ctx.reviewerName]),
    subject: "FunderMaps - Rapportage ter review",
    ...body,
  });
}

export async function sendApprovedEmail(ctx: ReportEmailContext): Promise<void> {
  const url = reportUrl(ctx);
  const body = render(
    [
      `Beste ${ctx.creatorName || "collega"},`,
      `Het ${KIND_LABEL[ctx.kind]} "${ctx.documentName}" is goedgekeurd door ${ctx.reviewerName}.`,
      `Het rapport is nu definitief en te bekijken via:`,
    ],
    url,
  );
  await sendMail({
    to: recipients([ctx.creatorEmail, ctx.creatorName], [ctx.reviewerEmail, ctx.reviewerName]),
    subject: "FunderMaps - Rapportage is goedgekeurd",
    ...body,
  });
}

export async function sendRejectedEmail(
  ctx: ReportEmailContext & { motivation: string },
): Promise<void> {
  const url = reportUrl(ctx);
  const body = render(
    [
      `Beste ${ctx.creatorName || "collega"},`,
      `Het ${KIND_LABEL[ctx.kind]} "${ctx.documentName}" is afgekeurd door ${ctx.reviewerName}.`,
      `Motivatie: ${ctx.motivation}`,
      `Pas het rapport aan en bied het opnieuw ter review aan via:`,
    ],
    url,
  );
  await sendMail({
    to: recipients([ctx.creatorEmail, ctx.creatorName], [ctx.reviewerEmail, ctx.reviewerName]),
    subject: "FunderMaps - Rapportage is afgekeurd",
    ...body,
  });
}
