import type { MiddlewareHandler } from "hono";
import { env } from "../config.ts";

/**
 * CSRF guard for cookie sessions.
 *
 * The frontends authenticate with the Better Auth session cookie (SameSite=Lax,
 * so a cross-site form POST or fetch never carries it -- that is the primary
 * defence). This is the belt to those braces: a mutating request that arrives
 * WITH a session cookie must come from a first-party origin. Bearer and API-key
 * callers send no cookie and are untouched; /api/auth/* runs Better Auth's own
 * origin check and is skipped here.
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

export function isCrossSiteWithSession(
  req: {
    method: string;
    path: string;
    header: (name: string) => string | undefined;
  },
  trustedOrigins: readonly string[],
): boolean {
  if (!MUTATING.has(req.method) || req.path.startsWith("/api/auth/")) return false;
  if (!SESSION_COOKIE.test(req.header("Cookie") ?? "")) return false;
  const site = req.header("Sec-Fetch-Site");
  const origin = req.header("Origin");
  return site === "cross-site" || (!!origin && !trustedOrigins.includes(origin));
}

export const csrfGuard: MiddlewareHandler = async (c, next) => {
  if (isCrossSiteWithSession(c.req, env.TRUSTED_ORIGINS)) {
    return c.json({ error: "Cross-site request rejected" }, 403);
  }
  await next();
};
