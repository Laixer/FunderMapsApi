// Short-lived render tokens for the report front-end (FunderMapsReport).
//
// Why. The report SPA is only ever rendered by Gotenberg (headless Chromium)
// for POST /api/pdf/:id. It has no session, so it used to carry a static
// `fmsk.` key baked into its public JavaScript bundle. That key belongs to a
// platform-org account, so anyone who pulled it out of the bundle could read
// every organisation's data, the review lane included.
//
// What replaces it. /api/pdf/:id mints one token per render and hands it to
// Gotenberg in the URL fragment (never sent to a server, so never logged). The
// token is:
//   * short-lived        expires REPORT_TOKEN_TTL_SECONDS after minting
//   * building-bound     valid only for the pand being rendered
//   * read-only          GET only, and only the routes the report calls
// It authenticates as REPORT_SERVICE_USER_ID, the account the static key
// belonged to, so a PDF shows exactly what it showed before.
//
// Format: fmrt.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>

import { createHmac, timingSafeEqual } from "node:crypto";

export const REPORT_TOKEN_PREFIX = "fmrt.";
export const REPORT_TOKEN_TTL_SECONDS = 300;

export interface ReportTokenPayload {
  /** The pand being rendered: the :id of POST /api/pdf/:id. */
  b: string;
  /** Who asked for the PDF (for logs; the token acts as the service user). */
  r: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function mintReportToken(
  buildingId: string,
  requestedBy: string,
  secret: string,
  now: number = Date.now(),
): string {
  const payload: ReportTokenPayload = {
    b: buildingId,
    r: requestedBy,
    exp: Math.floor(now / 1000) + REPORT_TOKEN_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${REPORT_TOKEN_PREFIX}${body}.${sign(body, secret)}`;
}

/** The payload when the token is authentic and unexpired, otherwise null. */
export function verifyReportToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): ReportTokenPayload | null {
  if (!token.startsWith(REPORT_TOKEN_PREFIX)) return null;
  const parts = token.slice(REPORT_TOKEN_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];

  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  let payload: ReportTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.b !== "string" || typeof payload?.exp !== "number") return null;
  if (payload.exp <= Math.floor(now / 1000)) return null;
  return payload;
}

// The routes the report front-end calls (FunderMapsReport src/services/api/
// building.ts), and nothing else. `building` routes carry the pand in the path
// and must match the token's; `inquiry` / `recovery` routes carry a report id,
// which the middleware checks belongs to that pand.
export type ReportRouteMatch =
  | { kind: "building"; buildingId: string }
  | { kind: "inquiry"; id: number }
  | { kind: "recovery"; id: number };

const BUILDING_ROUTES = [
  /^\/api\/product\/([^/]+)\/(?:analysis|statistics|subsidence\/historic)$/,
  /^\/api\/report\/([^/]+)$/,
  /^\/api\/inquiry\/building\/([^/]+)$/,
  /^\/api\/recovery\/building\/([^/]+)$/,
  /^\/api\/incident\/building\/([^/]+)$/,
];
const INQUIRY_ROUTE = /^\/api\/inquiry\/(\d+)\/(?:sample|download)$/;
const RECOVERY_ROUTE = /^\/api\/recovery\/(\d+)\/(?:sample|download)$/;

export function matchReportRoute(method: string, path: string): ReportRouteMatch | null {
  if (method !== "GET") return null;
  for (const re of BUILDING_ROUTES) {
    const m = path.match(re);
    if (m) return { kind: "building", buildingId: decodeURIComponent(m[1]!) };
  }
  const inq = path.match(INQUIRY_ROUTE);
  if (inq) return { kind: "inquiry", id: Number(inq[1]) };
  const rec = path.match(RECOVERY_ROUTE);
  if (rec) return { kind: "recovery", id: Number(rec[1]) };
  return null;
}
