import { describe, test, expect } from "bun:test";

import { isCrossSiteWithSession as check } from "./csrf";

const TRUSTED = ["https://maps.fundermaps.com", "https://auth.fundermaps.com"];
const isCrossSiteWithSession = (r: Parameters<typeof check>[0]) => check(r, TRUSTED);

const req = (method: string, path: string, headers: Record<string, string>) => ({
  method,
  path,
  header: (n: string) => headers[n] ?? headers[n.toLowerCase()],
});
const COOKIE = "__Secure-better-auth.session_token=abc.def; other=1";

describe("csrf guard", () => {
  test("first-party mutating request with a session cookie passes", () => {
    expect(isCrossSiteWithSession(req("POST", "/api/inquiry", { Cookie: COOKIE, Origin: "https://maps.fundermaps.com", "Sec-Fetch-Site": "same-site" }))).toBe(false);
  });
  test("cross-site origin with a session cookie is rejected", () => {
    expect(isCrossSiteWithSession(req("POST", "/api/inquiry", { Cookie: COOKIE, Origin: "https://evil.example" }))).toBe(true);
  });
  test("Sec-Fetch-Site cross-site with a session cookie is rejected even without Origin", () => {
    expect(isCrossSiteWithSession(req("DELETE", "/api/inquiry/1", { Cookie: COOKIE, "Sec-Fetch-Site": "cross-site" }))).toBe(true);
  });
  test("GET is never blocked", () => {
    expect(isCrossSiteWithSession(req("GET", "/api/inquiry", { Cookie: COOKIE, Origin: "https://evil.example" }))).toBe(false);
  });
  test("no session cookie: bearer / API-key callers are untouched", () => {
    expect(isCrossSiteWithSession(req("POST", "/api/inquiry", { Origin: "https://report.fundermaps.com", Authorization: "Bearer fmsk.x" }))).toBe(false);
  });
  test("/api/auth/* is left to Better Auth", () => {
    expect(isCrossSiteWithSession(req("POST", "/api/auth/sign-out", { Cookie: COOKIE, Origin: "https://evil.example" }))).toBe(false);
  });
  test("no Origin and no Sec-Fetch-Site (non-browser client with a cookie) passes", () => {
    expect(isCrossSiteWithSession(req("POST", "/api/inquiry", { Cookie: COOKIE }))).toBe(false);
  });
});
