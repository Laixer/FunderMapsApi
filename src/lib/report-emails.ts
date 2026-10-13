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
import { escapeHtml, wrapHtml } from "./mail-html.ts";

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

/** An account as a mail needs it: where to write, and what to call the person ("" when no name is stored). */
export interface ReportContact {
  email: string;
  name: string;
}

/**
 * The name is the person's given and family name, as the Studio shows it.
 * Never the e-mail address (the attribution's `*Name` fields and `user.name`
 * can both hold one): an account without a name gives "" and the templates
 * fall back to "collega" / "reviewer".
 */
export function contactOf(u: { email: string; givenName: string | null; lastName: string | null }): ReportContact {
  const name = [u.givenName, u.lastName].map((part) => part?.trim()).filter(Boolean).join(" ");
  return { email: u.email, name };
}

// Resolve creator/reviewer user ids to an address and a name. Attribution only
// carries ids; both come from application.user.
export async function lookupUserContacts(ids: string[]): Promise<Map<string, ReportContact>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: user.id, email: user.email, givenName: user.givenName, lastName: user.lastName })
    .from(user)
    .where(inArray(user.id, unique));
  return new Map(rows.map((r) => [r.id, contactOf(r)]));
}

/** The people of a ReportEmailContext. An id without an account (deleted) gives empty strings. */
export function reportParties(
  attr: { creator: string; reviewer: string },
  contacts: Map<string, ReportContact>,
): Pick<ReportEmailContext, "creatorEmail" | "creatorName" | "reviewerEmail" | "reviewerName"> {
  const creator = contacts.get(attr.creator);
  const reviewer = contacts.get(attr.reviewer);
  return {
    creatorEmail: creator?.email ?? "",
    creatorName: creator?.name ?? "",
    reviewerEmail: reviewer?.email ?? "",
    reviewerName: reviewer?.name ?? "",
  };
}

const KIND_LABEL: Record<ReportKind, string> = {
  inquiry: "onderzoeksrapport",
  recovery: "herstelrapport",
};

// What the subject calls the report. "Rapportage" is the Studio's word for an
// inquiry only; the body of a herstel mail speaks of a herstelrapport.
const SUBJECT_LABEL: Record<ReportKind, string> = {
  inquiry: "Rapportage",
  recovery: "Herstelrapport",
};

// A name is free text from the account page; these characters would end or
// split the address in a "Name <address>" recipient.
function headerName(name: string): string {
  return name.replace(/[<>()[\]:;,"\\\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

// Attribution rows can point at users without a resolvable address (deleted
// accounts, #973 backfill placeholders). Drop those rather than sending an
// invalid "to" that fails the whole call.
function recipients(...pairs: [email: string, name: string][]): string[] {
  return pairs
    .filter(([email]) => email.includes("@"))
    .map(([email, name]) => {
      const display = headerName(name);
      return display ? `${display} <${email}>` : email;
    });
}

function reportUrl(ctx: ReportEmailContext): string {
  return `${env.STUDIO_URL}/${ctx.kind}/${ctx.id}`;
}

// Wrap a list of paragraphs (plain strings; the URL is linked automatically)
// into both bodies. Keeps the two renderings from drifting apart.
function render(paragraphs: string[], url: string): { text: string; html: string } {
  const text = [...paragraphs, url, "Met vriendelijke groet,\nFunderMaps"].join("\n\n");
  const html = wrapHtml(
    // A reviewer's motivation can run over several lines; keep them apart in HTML too.
    paragraphs.map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`).join("") +
      `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` +
      `<p>Met vriendelijke groet,<br>FunderMaps</p>`,
  );
  return { text, html };
}

/** A mail ready for sendMail. Built apart from the send so the words can be tested. */
export interface ReportMail {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export function buildReviewRequestedEmail(ctx: ReportEmailContext): ReportMail {
  const organization = ctx.organizationName ? ` (${ctx.organizationName})` : "";
  return {
    to: recipients([ctx.reviewerEmail, ctx.reviewerName]),
    subject: `FunderMaps - ${SUBJECT_LABEL[ctx.kind]} ter review`,
    ...render(
      [
        `Beste ${ctx.reviewerName || "reviewer"},`,
        `${ctx.creatorName || "Een collega"}${organization} heeft het ${KIND_LABEL[ctx.kind]} "${ctx.documentName}" ter review aangeboden.`,
        `Open het rapport in de FunderMaps Studio om het te beoordelen:`,
      ],
      reportUrl(ctx),
    ),
  };
}

export function buildApprovedEmail(ctx: ReportEmailContext): ReportMail {
  return {
    to: recipients([ctx.creatorEmail, ctx.creatorName], [ctx.reviewerEmail, ctx.reviewerName]),
    subject: `FunderMaps - ${SUBJECT_LABEL[ctx.kind]} is goedgekeurd`,
    ...render(
      [
        `Beste ${ctx.creatorName || "collega"},`,
        `Het ${KIND_LABEL[ctx.kind]} "${ctx.documentName}" is goedgekeurd door ${ctx.reviewerName || "de reviewer"}.`,
        `Het rapport is nu definitief en te bekijken via:`,
      ],
      reportUrl(ctx),
    ),
  };
}

export function buildRejectedEmail(ctx: ReportEmailContext & { motivation: string }): ReportMail {
  return {
    to: recipients([ctx.creatorEmail, ctx.creatorName], [ctx.reviewerEmail, ctx.reviewerName]),
    subject: `FunderMaps - ${SUBJECT_LABEL[ctx.kind]} is afgekeurd`,
    ...render(
      [
        `Beste ${ctx.creatorName || "collega"},`,
        `Het ${KIND_LABEL[ctx.kind]} "${ctx.documentName}" is afgekeurd door ${ctx.reviewerName || "de reviewer"}.`,
        `Motivatie: ${ctx.motivation}`,
        `Pas het rapport aan en bied het opnieuw ter review aan via:`,
      ],
      reportUrl(ctx),
    ),
  };
}

export async function sendReviewRequestedEmail(ctx: ReportEmailContext): Promise<void> {
  await sendMail(buildReviewRequestedEmail(ctx));
}

export async function sendApprovedEmail(ctx: ReportEmailContext): Promise<void> {
  await sendMail(buildApprovedEmail(ctx));
}

export async function sendRejectedEmail(
  ctx: ReportEmailContext & { motivation: string },
): Promise<void> {
  await sendMail(buildRejectedEmail(ctx));
}
