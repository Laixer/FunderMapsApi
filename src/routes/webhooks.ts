// Inbound mail (docs/dataops-pipeline.md §11): melding@funderdata.nl has no
// mailbox -- Resend receives for the domain and POSTs an event here. This
// route is deliberately minimal: it verifies the signature, finds the dossier
// a reply belongs to, and appends the text to the timeline. Attachments and
// mails that open a NEW dossier are the (later) email-in step; today their
// presence is only noted, so nothing arrives unseen.
//
// Mounted without auth (Resend cannot log in); the Svix signature is the
// authentication. The webhook payload carries metadata only -- the body text
// is fetched back from the Resend API by email_id.

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { env } from "../config.ts";
import { db } from "../db/client.ts";
import { dossier } from "../db/schema/dataops.ts";
import { addEntry } from "../lib/dossier-entries.ts";
import { verifyWebhookSignature } from "../lib/svix.ts";

const webhooks = new Hono();

/** "FM2026-123456", from a plus-address or a subject line. */
const REFERENCE_RE = /\bFM\d{4}-\d{4,8}\b/i;
const PLUS_ADDRESS_RE = /\+(FM\d{4}-\d{4,8})@/i;

/** Resend renders addresses as strings or {email, name} objects; take both. */
function addressesOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(addressesOf);
  if (value && typeof value === "object" && "email" in value) {
    const email = (value as { email?: unknown }).email;
    return typeof email === "string" ? [email] : [];
  }
  return [];
}

function referenceOf(data: Record<string, unknown>): string | null {
  for (const addr of [...addressesOf(data.to), ...addressesOf(data.cc)]) {
    const m = addr.match(PLUS_ADDRESS_RE);
    if (m) return m[1]!.toUpperCase();
  }
  if (typeof data.subject === "string") {
    const m = data.subject.match(REFERENCE_RE);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

/** The message text, fetched back by id. Null when Resend cannot hand it over. */
async function fetchReceivedText(emailId: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`resend receiving fetch failed: ${response.status} for ${emailId}`);
      return null;
    }
    const body = (await response.json()) as { text?: unknown; html?: unknown };
    if (typeof body.text === "string" && body.text.trim()) return body.text.trim();
    if (typeof body.html === "string" && body.html.trim()) {
      return body.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    return null;
  } catch (err) {
    console.error(`resend receiving fetch failed for ${emailId}:`, err);
    return null;
  }
}

webhooks.post("/resend", async (c) => {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) return c.json({ message: "webhook secret not configured" }, 503);

  const payload = await c.req.text();
  const valid = verifyWebhookSignature(
    secret,
    {
      id: c.req.header("svix-id"),
      timestamp: c.req.header("svix-timestamp"),
      signature: c.req.header("svix-signature"),
    },
    payload,
  );
  if (!valid) return c.json({ message: "invalid signature" }, 401);

  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(payload);
  } catch {
    return c.json({ message: "not json" }, 400);
  }
  // Everything below answers 200: Resend retries non-2xx, and retrying will
  // not make an unroutable mail routable.
  if (event.type !== "email.received") return c.json({ ok: true, ignored: event.type });

  const data = event.data ?? {};
  const emailId = typeof data.email_id === "string" ? data.email_id : null;
  const reference = referenceOf(data);
  if (!reference) {
    console.warn(`inbound mail without a dossier reference, dropped (email ${emailId})`);
    return c.json({ ok: true, matched: false });
  }

  const [head] = await db
    .select({ id: dossier.id })
    .from(dossier)
    .where(eq(dossier.reference, reference))
    .limit(1);
  if (!head) {
    console.warn(`inbound mail for unknown reference ${reference} (email ${emailId})`);
    return c.json({ ok: true, matched: false });
  }

  const from = addressesOf(data.from)[0] ?? "unknown";
  const attachments = Array.isArray(data.attachments) ? data.attachments.length : 0;
  const text = emailId ? await fetchReceivedText(emailId) : null;

  await addEntry({
    dossierId: head.id,
    kind: "reply",
    actorKind: "melder",
    actor: from,
    text:
      (text ?? "(inhoud kon niet worden opgehaald)").slice(0, 8000) +
      (attachments ? `\n\n[${attachments} bijlage(n) — nog niet opgeslagen]` : ""),
    body: { email_id: emailId, attachments },
    visibleToMelder: true,
    // Dedupes webhook replays via the unique index on mail_message_id.
    mailMessageId: emailId,
  });

  console.info(`inbound reply on dossier ${head.id} (${reference}) from ${from}`);
  return c.json({ ok: true, matched: true });
});

export default webhooks;
