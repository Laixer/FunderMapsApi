import { describe, expect, test } from "bun:test";
import {
  matchReportRoute,
  mintReportToken,
  REPORT_TOKEN_TTL_SECONDS,
  verifyReportToken,
} from "./report-token.ts";

const SECRET = "x".repeat(48);
const PAND = "NL.IMBAG.PAND.0363100012166480";
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

describe("report render token", () => {
  test("round trip carries the pand and the requester", () => {
    const token = mintReportToken(PAND, "user-1", SECRET, NOW);
    expect(token.startsWith("fmrt.")).toBe(true);
    const payload = verifyReportToken(token, SECRET, NOW + 1000);
    expect(payload?.b).toBe(PAND);
    expect(payload?.r).toBe("user-1");
  });

  test("expires after the TTL", () => {
    const token = mintReportToken(PAND, "u", SECRET, NOW);
    expect(verifyReportToken(token, SECRET, NOW + (REPORT_TOKEN_TTL_SECONDS - 1) * 1000)).not.toBeNull();
    expect(verifyReportToken(token, SECRET, NOW + REPORT_TOKEN_TTL_SECONDS * 1000)).toBeNull();
  });

  test("a different secret does not verify", () => {
    const token = mintReportToken(PAND, "u", SECRET, NOW);
    expect(verifyReportToken(token, "y".repeat(48), NOW)).toBeNull();
  });

  test("a payload swapped to another pand does not verify", () => {
    const token = mintReportToken(PAND, "u", SECRET, NOW);
    const [, mac] = token.slice(5).split(".");
    const forged = Buffer.from(JSON.stringify({ b: "NL.IMBAG.PAND.0000000000000001", r: "u", exp: 9e9 })).toString("base64url");
    expect(verifyReportToken(`fmrt.${forged}.${mac}`, SECRET, NOW)).toBeNull();
  });

  test("garbage and other prefixes are refused", () => {
    expect(verifyReportToken("fmsk.abc", SECRET, NOW)).toBeNull();
    expect(verifyReportToken("fmrt.", SECRET, NOW)).toBeNull();
    expect(verifyReportToken("fmrt.a.b.c", SECRET, NOW)).toBeNull();
    expect(verifyReportToken("fmrt.not-json.sig", SECRET, NOW)).toBeNull();
  });
});

describe("routes a render token may call", () => {
  test("every building route the report uses", () => {
    for (const p of [
      `/api/product/${PAND}/analysis`,
      `/api/product/${PAND}/statistics`,
      `/api/product/${PAND}/subsidence/historic`,
      `/api/report/${PAND}`,
      `/api/inquiry/building/${PAND}`,
      `/api/recovery/building/${PAND}`,
      `/api/incident/building/${PAND}`,
    ]) {
      expect(matchReportRoute("GET", p)).toEqual({ kind: "building", buildingId: PAND });
    }
  });

  test("report-id routes", () => {
    expect(matchReportRoute("GET", "/api/inquiry/159153/sample")).toEqual({ kind: "inquiry", id: 159153 });
    expect(matchReportRoute("GET", "/api/inquiry/159153/download")).toEqual({ kind: "inquiry", id: 159153 });
    expect(matchReportRoute("GET", "/api/recovery/42/sample")).toEqual({ kind: "recovery", id: 42 });
    expect(matchReportRoute("GET", "/api/recovery/42/download")).toEqual({ kind: "recovery", id: 42 });
  });

  test("nothing else: other methods, other routes, the review lane", () => {
    expect(matchReportRoute("POST", `/api/report/${PAND}`)).toBeNull();
    expect(matchReportRoute("PUT", "/api/inquiry/1/sample")).toBeNull();
    expect(matchReportRoute("GET", "/api/dataops/queue")).toBeNull();
    expect(matchReportRoute("GET", "/api/inquiry")).toBeNull();
    expect(matchReportRoute("GET", "/api/inquiry/1")).toBeNull();
    expect(matchReportRoute("GET", "/api/user/me")).toBeNull();
    expect(matchReportRoute("GET", "/api/management/user")).toBeNull();
    expect(matchReportRoute("GET", `/api/product/${PAND}/analysis/extra`)).toBeNull();
  });

  test("a percent-encoded pand is decoded before comparison", () => {
    expect(matchReportRoute("GET", "/api/report/NL.IMBAG.PAND.0363100012166480")).toEqual({ kind: "building", buildingId: PAND });
  });
});
