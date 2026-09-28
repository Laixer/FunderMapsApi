import { describe, expect, test } from "bun:test";
import { inquirySample } from "../db/schema/report.ts";
import { numericOverflows } from "./numeric-limits.ts";

describe("numericOverflows", () => {
  test("a lintvoeg ratio of 1:1117 fits since numeric(7,2) (Worker #223, dossier 5599)", () => {
    expect(numericOverflows(inquirySample, { skewedParallel: 1117, skewedPerpendicular: 690 })).toEqual([]);
  });

  test("names a value that does not fit numeric(5,2)", () => {
    expect(numericOverflows(inquirySample, { pileDiameterTop: 1200 })).toEqual(["pile_diameter_top: 1200 past niet in het veld (maximaal 999.99)"]);
  });

  test("accepts the limit itself, negatives within range, nulls and non-numeric keys", () => {
    expect(numericOverflows(inquirySample, { skewedParallel: 99999.99, groundwaterLevelNet: -12.5, woodLevel: null, note: "x" })).toEqual([]);
  });
});
