import { describe, expect, test } from "bun:test";
import { dailySeries, median } from "./studio-today.ts";

describe("dailySeries", () => {
  const days = ["2026-10-20", "2026-10-21", "2026-10-22"];

  test("zero where nothing happened, the count where it did", () => {
    const out = dailySeries(days, [
      { day: "2026-10-21", metric: "received", n: 12 },
      { day: "2026-10-22", metric: "received", n: 3 },
      { day: "2026-10-22", metric: "judged", n: 40 },
    ]);
    expect(out.received).toEqual([0, 12, 3]);
    expect(out.judged).toEqual([0, 0, 40]);
    expect(out.read).toEqual([0, 0, 0]);
    expect(out.committed).toEqual([0, 0, 0]);
  });

  test("a day outside the span, or an unknown metric, is ignored; bigint strings add up", () => {
    const out = dailySeries(days, [
      { day: "2026-10-01", metric: "received", n: 9 },
      { day: "2026-10-20", metric: "teleported", n: 9 },
      { day: "2026-10-20", metric: "read", n: "4" as unknown as number },
      { day: "2026-10-20", metric: "read", n: 1 },
    ]);
    expect(out.received).toEqual([0, 0, 0]);
    expect(out.read).toEqual([5, 0, 0]);
  });
});

describe("median", () => {
  test("odd, even, empty", () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, 30, 41])).toBe(25);
    expect(median([])).toBeNull();
  });
});
