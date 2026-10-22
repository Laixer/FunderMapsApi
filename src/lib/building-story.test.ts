import { describe, expect, test } from "bun:test";
import { modelChangesFor } from "./building-story.ts";

const PAND = "NL.IMBAG.PAND.0392100000005759";

describe("modelChangesFor", () => {
  const rows = [
    {
      dossierId: 5,
      at: "2026-10-20T10:00:00Z",
      body: {
        changes: [
          { address: "Voorbeeldstraat 12", buildingId: PAND, fields: [{ label: "droogstand", before: "d", after: "a", beforeLabel: "D", afterLabel: "A" }] },
          { address: "Elders 1", buildingId: "NL.IMBAG.PAND.1", fields: [{ label: "droogstand", before: "c", after: "b" }] },
        ],
      },
    },
    { dossierId: 6, at: "2026-10-21T09:00:00Z", body: { changes: [{ buildingId: PAND.toLowerCase(), fields: [{ label: "funderingstype", before: "hout", after: "beton" }] }] } },
    { dossierId: 7, at: "2026-10-21T10:00:00Z", body: { changes: [] } },
    { dossierId: 8, at: "2026-10-22T10:00:00Z", body: null },
  ];

  test("only this pand, newest first, the map's letters when given", () => {
    const out = modelChangesFor(rows, PAND);
    expect(out.map((c) => c.dossierId)).toEqual([6, 5]);
    expect(out[1]!.fields).toEqual([{ label: "droogstand", before: "D", after: "A" }]);
    expect(out[1]!.address).toBe("Voorbeeldstraat 12");
    expect(out[0]!.address).toBeNull();
    expect(out[0]!.fields[0]).toEqual({ label: "funderingstype", before: "hout", after: "beton" });
  });

  test("a field that did not move, or a change without fields, is no change", () => {
    const still = [{ dossierId: 9, at: "2026-10-22T11:00:00Z", body: { changes: [{ buildingId: PAND, fields: [{ label: "droogstand", before: "a", after: "a" }] }, { buildingId: PAND }] } }];
    expect(modelChangesFor(still, PAND)).toEqual([]);
  });

  test("nothing for a pand nobody recalculated", () => {
    expect(modelChangesFor(rows, "NL.IMBAG.PAND.2")).toEqual([]);
  });
});
