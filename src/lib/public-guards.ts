import type { Context } from "hono";
import { env } from "../config.ts";
import { AppError } from "./errors.ts";

// Guards for the routes an anonymous stranger may call (routes/submission.ts,
// the melden portal): a per-IP speed bump and Cloudflare Turnstile. Moved from
// the melden app's server (FunderMapsIntake server/utils, 2026-10-30) when its
// routes moved into the API.

/**
 * The caller's address. On DigitalOcean's edge, x-forwarded-for is multi-hop
 * and spoofable; do-connecting-ip is set by the edge and overwritten on every
 * request, so it is the only header that means anything (lib/auth.ts does the
 * same). Without it (a local run) the forwarded header, then one shared key.
 */
export function clientIp(header: (name: string) => string | undefined): string {
  return (
    header("do-connecting-ip") ??
    header("x-real-ip") ??
    header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * A crude per-IP window, one per route (`bucket`). In-memory, so it does not
 * survive a restart and does not span instances. That is deliberate: this is a
 * speed bump against a bored script, not a security control; the real limit is
 * that every object lands under a key only the API hands out.
 */
export class Throttle {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number) {}

  /** Whether one more request from `ip` at `now` is allowed; records it either way. */
  allow(ip: string, now = Date.now()): boolean {
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(ip, recent);
    // Opportunistic sweep so the map cannot grow without bound.
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return recent.length <= this.limit;
  }
}

export function throttle(t: Throttle, c: Context): void {
  if (!t.allow(clientIp((n) => c.req.header(n)))) {
    throw new AppError(429, "Te veel verzoeken. Probeer het over een minuut nog eens.");
  }
}

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Cloudflare Turnstile, the check that a person is filling in the form. The
 * throttle stops one busy address; this stops a script that spreads itself over
 * many. The browser sends a fresh token (header x-turnstile-token) with every
 * upload grant and with the submission (a token verifies once). Off until
 * TURNSTILE_SECRET is set, so the form works the same without it.
 */
export async function requireHuman(c: Context, fetcher: typeof fetch = fetch, secret = env.TURNSTILE_SECRET): Promise<void> {
  if (!secret) return;
  const token = c.req.header("x-turnstile-token") ?? "";
  if (!token) throw new AppError(403, "De controle ontbreekt. Vernieuw de pagina en probeer het opnieuw.");

  let outcome: { success?: boolean; "error-codes"?: string[] };
  try {
    const res = await fetcher(SITEVERIFY, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: clientIp((n) => c.req.header(n)) }),
      signal: AbortSignal.timeout(10_000),
    });
    outcome = (await res.json()) as typeof outcome;
  } catch (err) {
    // Cloudflare unreachable: refuse rather than wave everything through, but say
    // it is on our side so the melder tries again instead of giving up.
    console.error("turnstile siteverify failed", err instanceof Error ? err.message : err);
    throw new AppError(503, "De controle is even niet bereikbaar. Probeer het zo nog een keer.");
  }
  if (!outcome.success) {
    console.warn("turnstile refused", (outcome["error-codes"] ?? []).join(","));
    throw new AppError(403, "De controle is niet gelukt. Probeer het opnieuw.");
  }
}
