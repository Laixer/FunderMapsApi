import { describe, expect, test } from "bun:test";
import { validateRecoveryBody } from "./recovery-body.ts";

const ok = {
  documentType: "foundation_report",
  documentDate: "2024-05-01",
  samples: [{ building: "NL.IMBAG.PAND.0363100012166480", type: "beam_on_pile", status: "executed", pileType: "press", facade: ["front", "rear"], recoveryDate: "2024-04-12" }],
};

describe("validateRecoveryBody (Studio #341)", () => {
  test("a complete herstel passes", () => {
    expect(validateRecoveryBody(ok)).toEqual([]);
  });
  test("the minimum: document type, date, one pand with a type", () => {
    expect(validateRecoveryBody({ documentType: "unknown", documentDate: "2024-05-01", samples: [{ building: "NL.IMBAG.PAND.1", type: "unknown" }] })).toEqual([]);
  });
  test("every problem is reported at once", () => {
    const errors = validateRecoveryBody({ documentType: "drawing", documentDate: "1-5-2024", contractor: 0, samples: [] });
    expect(errors.length).toBe(4);
  });
  test("per-pand fields use the database's enum labels", () => {
    const errors = validateRecoveryBody({ ...ok, samples: [{ building: "x", type: "stalen buispalen", status: "done", pileType: "screw", facade: ["top"], permitDate: "gisteren" }] });
    expect(errors).toEqual([
      expect.stringContaining("samples[0].type"),
      expect.stringContaining("samples[0].status"),
      expect.stringContaining("samples[0].pileType"),
      expect.stringContaining("samples[0].facade"),
      expect.stringContaining("samples[0].permitDate"),
    ]);
  });
  test("a pand is required on every sample", () => {
    expect(validateRecoveryBody({ ...ok, samples: [{ building: "", type: "table" }] })).toEqual([expect.stringContaining("samples[0].building")]);
  });
});
