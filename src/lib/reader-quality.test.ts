import { describe, expect, test } from "bun:test";
import { missRate, summarise } from "./reader-quality.ts";

const row = (field: string, promptVersion: string, confirmed: number, corrected: number, rejected: number) => ({
  field,
  model: "google/gemini-3.7-flash",
  promptVersion,
  confirmed,
  corrected,
  rejected,
});

describe("summarise", () => {
  const s = summarise([
    row("built_year", "dataops-2026.1", 42, 0, 21),
    row("built_year", "dataops-2026.2", 858, 5, 3),
    row("contractor", "dataops-2026.2", 710, 1, 85),
  ]);

  test("overall", () => {
    expect(s.total).toEqual({ judged: 1725, confirmed: 1610, corrected: 6, rejected: 109 });
  });

  test("per field, most judged first, versions added up", () => {
    expect(s.fields).toEqual([
      { field: "built_year", judged: 929, confirmed: 900, corrected: 5, rejected: 24 },
      { field: "contractor", judged: 796, confirmed: 710, corrected: 1, rejected: 85 },
    ]);
  });

  test("per reader version, in the order they came", () => {
    expect(s.versions.map((v) => [v.promptVersion, v.judged])).toEqual([
      ["dataops-2026.1", 63],
      ["dataops-2026.2", 1662],
    ]);
  });

  test("nothing judged: zeros, no division by zero", () => {
    expect(summarise([])).toEqual({ total: { judged: 0, confirmed: 0, corrected: 0, rejected: 0 }, fields: [], versions: [] });
    expect(missRate({ judged: 0, confirmed: 0, corrected: 0, rejected: 0 })).toBe(0);
  });
});

describe("missRate", () => {
  test("corrected and rejected together", () => {
    expect(missRate({ judged: 796, confirmed: 710, corrected: 1, rejected: 85 })).toBeCloseTo(86 / 796);
  });
});
