// Resend signs webhook deliveries the Svix way (standard-webhooks spec):
// HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>" with the base64
// key from the whsec_ secret, compared against each "v1,<base64>" candidate
// in the svix-signature header. Implemented here directly -- it is ~20 lines
// against a stable spec, not worth a dependency.

import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export function verifyWebhookSignature(
  secret: string,
  headers: SvixHeaders,
  payload: string,
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  // A replayed delivery is as unwelcome as a forged one.
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${payload}`)
    .digest();

  return headers.signature.split(" ").some((candidate) => {
    const [version, sig] = candidate.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
