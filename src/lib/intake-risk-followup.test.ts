import { describe, test, expect } from "bun:test";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { compareRisk, buildRiskChangedEmail, explainBasis, buildRiskConfirmedEmail } = await import("./intake-risk-followup.ts");

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

const basis = (over: Record<string, unknown> = {}) => ({
  foundationType: "wood", foundationTypeReliability: "established", inquiryType: "archive_research",
  documentName: "Funderingskaart Haarlem", documentDate: "2025-11-03",
  drystandRisk: "b", drystand: 0.42, dewateringDepthRisk: "d", dewateringDepth: 1.27, bioInfectionRisk: "c",
  ...over,
});

describe("explainBasis (API #204)", () => {
  test("names the document the model uses, the type and the deciding measurement", () => {
    const lines = explainBasis(basis() as never);
    expect(lines[0]).toContain('"Funderingskaart Haarlem" (2025)');
    expect(lines[1]).toMatch(/^Funderingstype: .+\.$/);
    expect(lines[2]).toContain("ontwateringsdiepte (1,27 m)");
    expect(lines[2]).toContain("D");
  });
  test("no report on the pand: says where the type came from instead", () => {
    expect(explainBasis(basis({ inquiryType: null, documentName: null, foundationTypeReliability: "cluster" }) as never)[0]).toContain("panden in de buurt");
    expect(explainBasis(basis({ inquiryType: null, documentName: null, foundationTypeReliability: "indicative" }) as never)[0]).toContain("geschat");
  });
  test("a tie names both parts, no measurement guessed", () => {
    const last = explainBasis(basis({ drystandRisk: "d" }) as never).at(-1)!;
    expect(last).toContain("de droogstand en de ontwateringsdiepte");
  });
  test("three tied: a proper Dutch list", () => {
    expect(explainBasis(basis({ drystandRisk: "d", bioInfectionRisk: "d" }) as never).at(-1)).toContain("de droogstand, de ontwateringsdiepte en de bacteriële aantasting");
  });
  test("everything A: no 'hoogste risico A (geen risico)'", () => {
    expect(explainBasis(basis({ drystandRisk: "a", dewateringDepthRisk: "a", bioInfectionRisk: "a" }) as never).at(-1)).toBe("Geen van de onderdelen geeft een verhoogd risico.");
  });
  test("bacteriële aantasting has no measurement to quote", () => {
    const last = explainBasis(basis({ drystandRisk: "a", dewateringDepthRisk: "a", bioInfectionRisk: "e" }) as never).at(-1)!;
    expect(last).toBe(`Het hoogste risico komt uit de bacteriële aantasting: ${last.split(": ")[1]}`);
    expect(last).not.toContain(" m)");
  });
  test("no model row: says so, invents nothing", () => {
    expect(explainBasis(null)).toEqual(["Voor dit pand is op dit moment geen risicoberekening beschikbaar."]);
  });
});

describe("buildRiskConfirmedEmail (API #204)", () => {
  const mail = buildRiskConfirmedEmail({
    reference: "FM2026-000240", recipientName: "Jan",
    buildings: [{ address: "Spaarne 67C, 2011 CH Haarlem", risk: { drystand: "b", dewateringDepth: "d", bioInfection: "c", unclassified: null }, basis: basis() as never }],
    statusUrl: "https://melden.fundermaps.com/melding/FM2026-000240", replyTo: "x@y",
  });
  test("says plainly that nothing changed, with the basis", () => {
    expect(mail.subject).toContain("ongewijzigd");
    expect(mail.text).toContain("Het geregistreerde risico is ongewijzigd");
    expect(mail.text).toContain("Funderingskaart Haarlem");
    expect(mail.text).toContain("ontwateringsdiepte (1,27 m)");
  });
  test("leaves out 'dagelijks herberekend' (Don: it invites 'wanneer dan wel?')", () => {
    expect(mail.text).not.toContain("dagelijks");
  });
  test("invites a newer document or a herstel by reply", () => {
    expect(mail.text).toContain("hersteld");
  });
});
