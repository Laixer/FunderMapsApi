import { describe, expect, test } from "bun:test";
import { commitAndRisk, namesInquiry, people } from "./rapportage-origin.ts";

const anna = { givenName: "Anna", lastName: "Maker", name: null, email: "anna@stub.test" };

describe("namesInquiry", () => {
  test("inquiry_id, or one of inquiry_ids", () => {
    expect(namesInquiry({ inquiry_id: 161498 }, 161498)).toBe(true);
    expect(namesInquiry({ inquiry_id: "161498" }, 161498)).toBe(true);
    expect(namesInquiry({ inquiry_id: 1, inquiry_ids: [1, 161498] }, 161498)).toBe(true);
    expect(namesInquiry({ inquiry_id: 1 }, 161498)).toBe(false);
    expect(namesInquiry(null, 161498)).toBe(false);
  });
});

describe("commitAndRisk", () => {
  const commit = { dossierId: 5, at: "2026-10-21T10:00:00Z", text: "Overgenomen als rapportage — 1 adres", body: { inquiry_id: 7 }, ...anna };
  const before = { dossierId: 5, at: "2026-10-20T10:00:00Z", text: "Funderingsrisico herberekend: x", body: { changes: [{ address: "Oud 1", fields: [{ label: "droogstand", before: "c", after: "b" }] }] } };
  const after = {
    dossierId: 5,
    at: "2026-10-21T10:00:05Z",
    text: "Funderingsrisico herberekend: Voorbeeldstraat 12",
    body: { changes: [{ address: "Voorbeeldstraat 12", buildingId: "NL.IMBAG.PAND.1", fields: [{ label: "droogstand", before: "d", after: "a", beforeLabel: "D" }] }] },
  };

  test("the take-over of this rapportage, by name; risk changes from then on only", () => {
    expect(commitAndRisk([before, commit, after], 7)).toEqual({
      committed: { at: "2026-10-21T10:00:00Z", by: "Anna Maker" },
      risk: { changed: [{ address: "Voorbeeldstraat 12", fields: [{ label: "droogstand", before: "d", after: "a" }] }], unchanged: false },
    });
  });

  test("a recalculation that moved nothing says so", () => {
    const quiet = { ...after, body: { basis: {}, unchanged: true } };
    expect(commitAndRisk([commit, quiet], 7).risk).toEqual({ changed: [], unchanged: true });
  });

  test("another rapportage's take-over is not this one's; no recalculation is null", () => {
    expect(commitAndRisk([commit], 8)).toEqual({ committed: null, risk: null });
    expect(commitAndRisk([commit], 7).risk).toBeNull();
  });

  test("a take-over without a person (backfilled) keeps its date, no name", () => {
    const backfilled = { dossierId: 5, at: "2026-09-01T00:00:00Z", text: "Overgenomen als rapportage", body: { inquiry_id: 7, backfilled: true } };
    expect(commitAndRisk([backfilled], 7).committed).toEqual({ at: "2026-09-01T00:00:00Z", by: null });
  });
});

describe("people", () => {
  test("distinct, first seen first; without an e-mail address left out", () => {
    expect(people([anna, { givenName: null, lastName: null, name: "Bram", email: "b@stub.test" }, anna, { givenName: "X", lastName: null, name: null, email: null }])).toEqual([
      "Anna Maker",
      "Bram",
    ]);
  });
});
