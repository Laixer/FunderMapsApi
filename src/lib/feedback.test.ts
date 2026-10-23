import { describe, expect, test } from "bun:test";
import { foldSubjects, subjectGroup, yearsFrom } from "./feedback.ts";

describe("yearsFrom", () => {
  test("every year, zero-filled, numbers", () => {
    expect(yearsFrom(2024, 2026, [{ year: "2024", portal: "391", melden: 0 }, { year: "2026", portal: 58, melden: "581" }])).toEqual([
      { year: "2024", portal: 391, melden: 0 },
      { year: "2025", portal: 0, melden: 0 },
      { year: "2026", portal: 58, melden: 581 },
    ]);
  });
});

describe("subjects", () => {
  test("follow-ups per dossier are one subject; blank is named", () => {
    expect(subjectGroup("Aanvullende stukken bij FM2026-000663")).toBe("Aanvullende stukken");
    expect(subjectGroup("Het funderingstype klopt niet")).toBe("Het funderingstype klopt niet");
    expect(subjectGroup(null)).toBe("(geen onderwerp)");
    expect(subjectGroup("  ")).toBe("(geen onderwerp)");
  });

  test("folded and summed, largest first", () => {
    expect(foldSubjects([
      { subject: "Aanvullende stukken bij FM2026-000663", received: "2", handled: 1, ledToReport: 0 },
      { subject: "Het funderingsrisico klopt niet", received: 249, handled: "230", ledToReport: 90 },
      { subject: "Aanvullende stukken bij FM2026-000534", received: 2, handled: 2, ledToReport: "1" },
    ])).toEqual([
      { subject: "Het funderingsrisico klopt niet", received: 249, handled: 230, ledToReport: 90 },
      { subject: "Aanvullende stukken", received: 4, handled: 3, ledToReport: 1 },
    ]);
  });
});
