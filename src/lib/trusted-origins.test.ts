import { describe, expect, test } from "bun:test";
import { withOwnOrigin } from "./trusted-origins.ts";
import { isCrossSiteWithSession } from "../middleware/csrf.ts";

describe("withOwnOrigin", () => {
  test("the app's own origin is added when the setting is empty (the Studio app, 2026-10-28)", () => {
    expect(withOwnOrigin([], "https://studio.funderdata.nl")).toEqual(["https://studio.funderdata.nl"]);
  });
  test("added once, as an origin (no path, no trailing slash)", () => {
    expect(withOwnOrigin(["https://app.fundermaps.com"], "https://api.fundermaps.com/")).toEqual(["https://app.fundermaps.com", "https://api.fundermaps.com"]);
    expect(withOwnOrigin(["https://studio.funderdata.nl"], "https://studio.funderdata.nl")).toEqual(["https://studio.funderdata.nl"]);
  });
  test("no BASE_URL: the setting as it is", () => {
    expect(withOwnOrigin(["https://a.example"], undefined)).toEqual(["https://a.example"]);
  });
  test("with it, the CSRF guard lets the app's own write through and still stops a stranger", () => {
    const trusted = withOwnOrigin([], "https://studio.funderdata.nl");
    const req = (origin: string) => ({
      method: "POST",
      path: "/api/dataops/dossier/1/remark",
      header: (name: string) => ({ Cookie: "__Secure-better-auth.session_token=x", Origin: origin } as Record<string, string>)[name],
    });
    expect(isCrossSiteWithSession(req("https://studio.funderdata.nl"), trusted)).toBe(false);
    expect(isCrossSiteWithSession(req("https://evil.example"), trusted)).toBe(true);
  });
});
