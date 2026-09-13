import { describe, test, expect } from "bun:test";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { compareRisk, buildRiskChangedEmail } = await import("./intake-risk-followup.ts");

const snapshot = {
  at: "2026-09-11T10:00:00.000Z",
  buildings: {
    b1: { address: "Jollenpad 13, 1081 KC Amsterdam", risk: { drystand: "a", dewateringDepth: "b", bioInfection: "a", unclassified: null } },
    b2: { address: "Molenwal 15, 3421 CK Oudewater", risk: { drystand: "c", dewateringDepth: "c", bioInfection: "c", unclassified: "d" } },
  },
};

describe("compareRisk", () => {
  test("nothing changed → no changes", () => {
    const current = new Map([
      ["b1", { drystand: "a", dewateringDepth: "b", bioInfection: "a", unclassified: null }],
      ["b2", { drystand: "c", dewateringDepth: "c", bioInfection: "c", unclassified: "d" }],
    ]);
    expect(compareRisk(snapshot, current)).toEqual([]);
  });

  test("one field on one pand → one change with before/after", () => {
    const current = new Map([
      ["b1", { drystand: "a", dewateringDepth: "b", bioInfection: "a", unclassified: null }],
      ["b2", { drystand: "c", dewateringDepth: "e", bioInfection: "c", unclassified: "d" }],
    ]);
    expect(compareRisk(snapshot, current)).toEqual([
      { buildingId: "b2", address: "Molenwal 15, 3421 CK Oudewater", fields: [{ label: "ontwateringsdiepte", before: "c", after: "e" }] },
    ]);
  });

  test("model row disappeared → every known value reads as changed to unknown", () => {
    const current = new Map([["b2", { drystand: "c", dewateringDepth: "c", bioInfection: "c", unclassified: "d" }]]);
    const [c] = compareRisk(snapshot, current);
    expect(c?.buildingId).toBe("b1");
    expect(c?.fields.map((f) => f.after)).toEqual([null, null, null]);
  });

  test("unclassified null on both sides is not a change", () => {
    const one = { at: snapshot.at, buildings: { b1: snapshot.buildings.b1 } };
    const current = new Map([["b1", { drystand: "a", dewateringDepth: "b", bioInfection: "a", unclassified: null }]]);
    expect(compareRisk(one, current)).toEqual([]);
  });
});

describe("buildRiskChangedEmail", () => {
  const mail = buildRiskChangedEmail({
    reference: "FM2026-000042",
    recipientName: "J. de Vries",
    changes: [{ buildingId: "b2", address: "Molenwal 15, 3421 CK Oudewater", fields: [{ label: "ontwateringsdiepte", before: "c", after: "e" }] }],
    statusUrl: "https://melden.fundermaps.com/melding/FM2026-000042",
    replyTo: "melding+FM2026-000042@funderdata.nl",
  });

  test("subject names the meldcode", () => {
    expect(mail.subject).toBe("FunderMaps - Het funderingsrisico van uw melding FM2026-000042 is herberekend");
  });

  test("body lists the address and the before → after in Dutch labels", () => {
    expect(mail.text).toContain("Beste J. de Vries");
    expect(mail.text).toContain("Molenwal 15, 3421 CK Oudewater");
    expect(mail.text).toMatch(/ontwateringsdiepte: .+ → .+/);
    expect(mail.text).toContain("dagelijks herberekend");
    expect(mail.text).toContain("https://melden.fundermaps.com/melding/FM2026-000042");
  });

  test("singular/plural intro follows the number of addresses", () => {
    expect(mail.text).toContain("het volgende adres");
  });
});
