import { describe, expect, test } from "bun:test";
import { inquirySample } from "../db/schema/report.ts";
import { numericOverflows } from "./numeric-limits.ts";

describe("numericOverflows", () => {
  test("names a lintvoeg ratio that does not fit numeric(5,2) (Worker #223, dossier 5599)", () => {
    const out = numericOverflows(inquirySample, { skewedParallel: 1117, skewedPerpendicular: 690 });
    expect(out).toEqual(["skewed_parallel: 1117 past niet in het veld (maximaal 999.99)"]);
  });

  test("accepts the limit itself, negatives within range, nulls and non-numeric keys", () => {
    expect(numericOverflows(inquirySample, { skewedParallel: 999.99, groundwaterLevelNet: -12.5, woodLevel: null, note: "x" })).toEqual([]);
  });
});
