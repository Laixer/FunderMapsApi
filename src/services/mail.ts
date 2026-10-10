// Transactional email via Resend (https://resend.com/docs/api-reference/emails/send-email).
// Replaced Mailgun on 2026-09-01. The only verified sending domain is
// funderdata.nl, so MAIL_FROM must stay on that domain until more are added.
//
// Fail-soft on purpose: a missing key logs and returns, a Resend error logs
// and returns. Mail is a notification side-channel, never the record of truth
// (see dossier_event), so it must never break an inquiry/recovery transition.

import { env } from "../config.ts";

export interface MailOptions {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
}

/**
 * What became of the send. Still fail-soft -- nothing here throws -- but a
 * caller keeping a send log (intake-emails.ts) needs to know whether to mark
 * the row sent or failed. `id` is Resend's message id on success.
 */
export interface MailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// "Name <address>" or a bare address -> the lower-cased address.
function addressOf(recipient: string): string {
  const m = recipient.match(/<([^<>]+)>\s*$/);
  return (m ? m[1]! : recipient).trim().toLowerCase();
}

/**
 * Split recipients into the ones to send to and the ones on the skip list
 * (MAIL_SKIP_RECIPIENTS): pipeline accounts with no mailbox. Resend suppresses
 * such an address after its first bounce but still records every attempt.
 */
export function dropSkipped(
  to: string[],
  skip: ReadonlySet<string>,
): { keep: string[]; dropped: string[] } {
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const r of to) (skip.has(addressOf(r)) ? dropped : keep).push(r);
  return { keep, dropped };
}

export async function sendMail(opts: MailOptions): Promise<MailResult> {
  const { keep: to, dropped } = dropSkipped(opts.to, env.MAIL_SKIP_RECIPIENTS);
  if (dropped.length > 0) {
    console.info(`Not mailing ${dropped.length} skip-listed recipient(s):`, opts.subject);
    if (to.length === 0) return { ok: false, error: "all recipients are on MAIL_SKIP_RECIPIENTS" };
  }

  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set, skipping email:", opts.subject);
    return { ok: false, error: "RESEND_API_KEY not set" };
  }

  if (to.length === 0) {
    console.warn("No recipients, skipping email:", opts.subject);
    return { ok: false, error: "no recipients" };
  }

  const payload = {
    from: opts.from ?? env.MAIL_FROM,
    to,
    subject: opts.subject,
    text: opts.text,
    ...(opts.html ? { html: opts.html } : {}),
    ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
  };

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Resend error:", response.status, detail);
      return { ok: false, error: `${response.status} ${detail}`.slice(0, 500) };
    }

    const data = (await response.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id };
  } catch (err) {
    console.error("Resend request failed:", err);
    return { ok: false, error: String(err).slice(0, 500) };
  }
}
