import { describe, expect, test } from "bun:test";
import { along, camel, FOUNDATION_FIELDS, monthsBetween, QUICKSCAN_REQUIRED } from "./data-quality.ts";

describe("monthsBetween", () => {
  test("inclusive, across a year", () => {
    expect(monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthsBetween("2026-10", "2026-10")).toEqual(["2026-10"]);
  });
});

describe("along", () => {
  test("zero-filled, numbers", () => {
    expect(along(["2026-08", "2026-09", "2026-10"], [{ key: "2026-10", value: "4" }, { key: "2026-08", value: 1 }])).toEqual([1, 0, 4]);
  });
});

describe("field names", () => {
  test("snake to the registry's camel", () => {
    expect(camel("pile_wood_capacity_vertical_quality")).toBe("pileWoodCapacityVerticalQuality");
    expect(camel("note")).toBe("note");
  });

  test("the lists hold plain column names only (they are spliced into SQL)", () => {
    for (const f of [...QUICKSCAN_REQUIRED, ...FOUNDATION_FIELDS]) expect(f).toMatch(/^[a-z_]+$/);
  });
});
