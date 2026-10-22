import { describe, expect, test } from "bun:test";
import { riskSpread, runGrid, slotOf } from "./model-runs.ts";

describe("slotOf", () => {
  test("before 17:00 midday, after evening", () => {
    expect(slotOf(13)).toBe("midday");
    expect(slotOf(22)).toBe("evening");
  });
});

describe("runGrid", () => {
  const days = ["2026-10-21", "2026-10-22"];
  const runs = [
    { day: "2026-10-21", hour: 13, status: "ok", finishedAt: "2026-10-21T11:34:49+00:00" },
    { day: "2026-10-21", hour: 22, status: "error", finishedAt: "2026-10-21T20:05:17+00:00" },
    { day: "2026-10-22", hour: 13, status: "ok", finishedAt: "2026-10-22T11:36:38+00:00" },
  ];

  test("newest day first; ok, failed; tonight's run not yet due is upcoming", () => {
    expect(runGrid(days, runs, { day: "2026-10-22", hour: 15 })).toEqual([
      {
        day: "2026-10-22",
        midday: { status: "ok", finishedAt: "2026-10-22T11:36:38+00:00" },
        evening: { status: "upcoming", finishedAt: null },
      },
      {
        day: "2026-10-21",
        midday: { status: "ok", finishedAt: "2026-10-21T11:34:49+00:00" },
        evening: { status: "failed", finishedAt: "2026-10-21T20:05:17+00:00" },
      },
    ]);
  });

  test("a slot without a run once it was due is missing", () => {
    const grid = runGrid(["2026-10-22"], [], { day: "2026-10-22", hour: 23 });
    expect(grid[0]).toEqual({ day: "2026-10-22", midday: { status: "missing", finishedAt: null }, evening: { status: "missing", finishedAt: null } });
  });
});

describe("riskSpread", () => {
  test("classes a–e and none, per risk", () => {
    expect(
      riskSpread([
        { risk: "drystand", klass: "a", n: 10 },
        { risk: "drystand", klass: "E", n: 2 },
        { risk: "drystand", klass: null, n: 5 },
        { risk: "bio_infection", klass: "c", n: 1 },
      ]),
    ).toEqual({
      drystand: { a: 10, b: 0, c: 0, d: 0, e: 2, none: 5 },
      bio_infection: { a: 0, b: 0, c: 1, d: 0, e: 0, none: 0 },
    });
  });
});
