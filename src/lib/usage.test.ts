import { describe, expect, test } from "bun:test";
import { foldOrganizations, productMonths, usageKind } from "./usage.ts";

describe("usageKind", () => {
  test("the boards' rule: a version suffix 3 or 4 is the billable webservice", () => {
    expect(usageKind("analysis3")).toBe("webservice");
    expect(usageKind("facade_scan4")).toBe("webservice");
    expect(usageKind("analysis")).toBe("maps");
    expect(usageKind("analysis2")).toBe("maps");
    expect(usageKind("riskindex")).toBe("maps");
  });
});

describe("foldOrganizations", () => {
  const rows = [
    { id: "a", name: "Alpha", product: "analysis3", month_to_date: "10", last_month: "20", last_30_days: "25", previous_30_days: "30" },
    { id: "a", name: "Alpha", product: "risk3", month_to_date: 1, last_month: 0, last_30_days: 2, previous_30_days: 0 },
    { id: "a", name: "Alpha", product: "analysis", month_to_date: 5, last_month: 5, last_30_days: 5, previous_30_days: 5 },
    { id: "b", name: null, product: "analysis3", month_to_date: 100, last_month: 0, last_30_days: 100, previous_30_days: 0 },
    { id: "c", name: "Quiet", product: "light3", month_to_date: 0, last_month: 0, last_30_days: 0, previous_30_days: 0 },
  ];

  test("per kind, summed over products, largest first, quiet ones out", () => {
    const ws = foldOrganizations(rows, "webservice");
    expect(ws.map((o) => o.id)).toEqual(["b", "a"]);
    expect(ws[1]).toEqual({ id: "a", name: "Alpha", month_to_date: 11, last_month: 20, last_30_days: 27, previous_30_days: 30, products: [{ product: "analysis3", last_30_days: 25 }, { product: "risk3", last_30_days: 2 }] });
    expect(ws[0]!.name).toBe("(naamloos)");
  });

  test("the map products apart", () => {
    expect(foldOrganizations(rows, "maps").map((o) => [o.id, o.last_30_days])).toEqual([["a", 5]]);
  });
});

describe("productMonths", () => {
  test("zero-filled along the months, one kind, largest first", () => {
    const months = ["2026-08", "2026-09", "2026-10"];
    expect(productMonths(months, [
      { product: "risk3", month: "2026-10", calls: "3" },
      { product: "analysis3", month: "2026-08", calls: 10 },
      { product: "analysis3", month: "2026-10", calls: "5" },
      { product: "analysis", month: "2026-10", calls: 99 },
      { product: "analysis3", month: "2025-01", calls: 1000 },
    ], "webservice")).toEqual([
      { product: "analysis3", calls: [10, 0, 5] },
      { product: "risk3", calls: [0, 0, 3] },
    ]);
  });
});
