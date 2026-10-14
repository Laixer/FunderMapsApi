import { describe, test, expect } from "bun:test";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { compareRisk, buildRiskChangedEmail, explainBasis, buildRiskConfirmedEmail, riskChangedLine, riskUnchangedLine } = await import("./intake-risk-followup.ts");
const emails = await import("./intake-emails.ts");

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
      { buildingId: "b2", address: "Molenwal 15, 3421 CK Oudewater", fields: [{ label: "ontwateringsdiepte", before: "c", after: "e", beforeLabel: "C", afterLabel: "E" }] },
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
    expect(mail.text).toContain("\n- Ontwateringsdiepte: C → E.\n");
    expect(mail.text).toContain("dagelijks herberekend");
    expect(mail.text).toContain("https://melden.fundermaps.com/melding/FM2026-000042");
  });

  test("singular/plural intro follows the number of addresses", () => {
    expect(mail.text).toContain("het volgende adres");
  });

  test("the address introduces its list with a colon, as in the afronding", () => {
    expect(mail.text).toContain("\n\nMolenwal 15, 3421 CK Oudewater:\n\n- Ontwateringsdiepte: ");
    expect(mail.html).toContain("<p>Molenwal 15, 3421 CK Oudewater:</p><ul><li>Ontwateringsdiepte: C → E.</li></ul>");
  });

  // The list of the "ongewijzigd" mail reads "Droogstand: C."; this one read "droogstand: C → E".
  test("every line of the list starts with a capital and ends with a full stop", () => {
    const changes = compareRisk(
      { at: "2026-09-30T10:00:00Z", buildings: { b1: { address: "Voorbeeldstraat 1", risk: { drystand: "c", dewateringDepth: "b", bioInfection: "b", unclassified: null } } } },
      new Map([["b1", { drystand: "e", dewateringDepth: "a", bioInfection: "c", unclassified: "d" }]]),
    );
    const changed = buildRiskChangedEmail({ reference: "FM2026-000042", recipientName: "", changes, statusUrl: "https://x", replyTo: "y" });
    expect(changed.text).toContain(
      "\n\nVoorbeeldstraat 1:\n\n" +
        "- Droogstand: C → E.\n" +
        "- Ontwateringsdiepte: B → A.\n" +
        "- Bacteriële aantasting: B → C.\n" +
        "- Vastgesteld risico: niet vastgesteld → D.\n\n",
    );
    expect(changed.html).toContain(
      "<ul><li>Droogstand: C → E.</li><li>Ontwateringsdiepte: B → A.</li><li>Bacteriële aantasting: B → C.</li><li>Vastgesteld risico: niet vastgesteld → D.</li></ul>",
    );
    const items = changed.text.split("\n").filter((line) => line.startsWith("- "));
    expect(items.length).toBe(4);
    for (const item of items) expect(item).toMatch(/^- \p{Lu}.*\.$/u);
  });

  test("only the mail's list changes: the labels stay the keys they are", () => {
    const changes = compareRisk(
      { at: "2026-09-30T10:00:00Z", buildings: { b1: { address: "Voorbeeldstraat 1", risk: { drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: null } } } },
      new Map([["b1", { drystand: null, dewateringDepth: "b", bioInfection: null, unclassified: "d" }]]),
    );
    // What is kept on the Verloop entry (body.changes) and matched for the "houten palen" paragraph.
    expect(changes[0]!.fields.map((f) => f.label)).toEqual(["droogstand", "ontwateringsdiepte", "bacteriële aantasting", "vastgesteld risico"]);
    const changed = buildRiskChangedEmail({ reference: "FM2026-000042", recipientName: "", changes, statusUrl: "https://x", replyTo: "y" });
    expect(changed.text).toContain("- Droogstand: C → niet van toepassing.\n");
    expect(changed.text).toContain("alleen voor een fundering op houten palen");
    // Inside a sentence the label keeps its small letter.
    expect(riskChangedLine(changes)).toBe(
      "Funderingsrisico herberekend: Voorbeeldstraat 1 – droogstand C → niet van toepassing, ontwateringsdiepte niet van toepassing → B, bacteriële aantasting B → niet van toepassing, vastgesteld risico niet vastgesteld → D",
    );
  });
});

const basis = (over: Record<string, unknown> = {}) => ({
  foundationType: "wood", foundationTypeReliability: "established", inquiryType: "archive_research",
  documentName: "Funderingskaart Haarlem", documentDate: "2025-11-03",
  drystandRisk: "b", drystand: 0.42, dewateringDepthRisk: "d", dewateringDepth: 1.27, bioInfectionRisk: "c",
  ...over,
});

describe("niet van toepassing vs niet bepaald (Don, 2026-10-02)", () => {
  test("an empty pile risk next to a computed one is niet van toepassing", () => {
    const { riskLabelIn } = emails;
    const r = { drystand: null, dewateringDepth: "d", bioInfection: null, unclassified: null };
    expect(riskLabelIn(r, r.drystand)).toBe("niet van toepassing");
    expect(riskLabelIn(r, r.dewateringDepth)).toBe("D");
  });

  test("all three empty is niet bepaald", () => {
    const { riskLabelIn } = emails;
    const r = { drystand: null, dewateringDepth: null, bioInfection: null, unclassified: null };
    expect(riskLabelIn(r, r.drystand)).toBe("niet bepaald");
    expect(riskLabelIn(null, null)).toBe("niet bepaald");
  });

  test("the changed mail says niet van toepassing when a pile risk falls away", () => {
    const changes = compareRisk(
      { at: "2026-09-30T10:00:00Z", buildings: { b1: { address: "Molenwal 15", risk: { drystand: "c", dewateringDepth: null, bioInfection: "d", unclassified: null } } } },
      new Map([["b1", { drystand: null, dewateringDepth: "b", bioInfection: null, unclassified: null }]]),
    );
    const mail = buildRiskChangedEmail({ reference: "FM2026-000042", recipientName: "", changes, statusUrl: "https://x", replyTo: "y" });
    expect(mail.text).toContain("Droogstand: C → niet van toepassing.");
    expect(mail.text).not.toContain("→ niet bepaald");
  });
});

describe("changed mail: the 'was' side reads like the 'now' side (2026-10-06)", () => {
  test("an empty pile risk that is now computed reads niet van toepassing → value", () => {
    const changes = compareRisk(
      { at: "2026-09-30T10:00:00Z", buildings: { b1: { address: "Molenwal 15", risk: { drystand: null, dewateringDepth: "d", bioInfection: null, unclassified: null } } } },
      new Map([["b1", { drystand: "c", dewateringDepth: null, bioInfection: "c", unclassified: null }]]),
    );
    const mail = buildRiskChangedEmail({ reference: "FM2026-000042", recipientName: "", changes, statusUrl: "https://x", replyTo: "y" });
    expect(mail.text).toContain("Droogstand: niet van toepassing → C.");
    expect(mail.text).not.toContain("niet bepaald →");
  });

  test("all empty before still reads niet bepaald", () => {
    const changes = compareRisk(
      { at: "2026-09-30T10:00:00Z", buildings: { b1: { address: "Molenwal 15", risk: { drystand: null, dewateringDepth: null, bioInfection: null, unclassified: null } } } },
      new Map([["b1", { drystand: "c", dewateringDepth: null, bioInfection: null, unclassified: "b" }]]),
    );
    const mail = buildRiskChangedEmail({ reference: "FM2026-000042", recipientName: "", changes, statusUrl: "https://x", replyTo: "y" });
    expect(mail.text).toContain("Droogstand: niet bepaald → C.");
    expect(mail.text).toContain("Vastgesteld risico: niet vastgesteld → B.");
  });
});

// "Vastgesteld risico: niet van toepassing → D" said the vastgesteld risico did not apply; it was
// only not set. "niet van toepassing" / "niet bepaald" are about the three computed risks.
describe("changed mail: a missing vastgesteld risico is niet vastgesteld", () => {
  const changesOf = (before: Record<string, string | null>, after: Record<string, string | null>) =>
    compareRisk({ at: "2026-09-30T10:00:00Z", buildings: { b1: { address: "Molenwal 15", risk: before as never } } }, new Map([["b1", after as never]]));

  test("on either side, whatever the other risks are", () => {
    for (const [before, after, line] of [
      [{ drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: null }, { drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: "d" }, "- Vastgesteld risico: niet vastgesteld → D.\n"],
      [{ drystand: null, dewateringDepth: null, bioInfection: null, unclassified: null }, { drystand: null, dewateringDepth: null, bioInfection: null, unclassified: "b" }, "- Vastgesteld risico: niet vastgesteld → B.\n"],
      [{ drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: "e" }, { drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: null }, "- Vastgesteld risico: E → niet vastgesteld.\n"],
      [{ drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: "c" }, { drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: "d" }, "- Vastgesteld risico: C → D.\n"],
    ] as const) {
      const mail = buildRiskChangedEmail({ reference: "FM2026-000042", recipientName: "", changes: changesOf(before, after), statusUrl: "https://x", replyTo: "y" });
      expect(mail.text).toContain(line);
    }
  });

  test("the three computed risks keep their words", () => {
    const changes = changesOf(
      { drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: null },
      { drystand: null, dewateringDepth: "b", bioInfection: null, unclassified: "d" },
    );
    const mail = buildRiskChangedEmail({ reference: "FM2026-000042", recipientName: "", changes, statusUrl: "https://x", replyTo: "y" });
    expect(mail.text).toContain("- Droogstand: C → niet van toepassing.\n- Ontwateringsdiepte: niet van toepassing → B.\n");
    expect(mail.text).toContain("- Vastgesteld risico: niet vastgesteld → D.\n");
  });

  test("what is kept on the Verloop entry (body.changes) is not touched", () => {
    const changes = changesOf(
      { drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: null },
      { drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: "d" },
    );
    expect(changes).toEqual([
      { buildingId: "b1", address: "Molenwal 15", fields: [{ label: "vastgesteld risico", before: null, after: "d", beforeLabel: "niet van toepassing", afterLabel: "D" }] },
    ]);
  });
});

// The Verloop line said "niet bepaald" where the mail beside it said "niet van toepassing".
describe("changed: the Verloop line uses the words of the mail", () => {
  test("every before → after of the mail's list is in the line, in the same words", () => {
    const changes = compareRisk(
      { at: "2026-09-30T10:00:00Z", buildings: {
        b1: { address: "Voorbeeldstraat 1", risk: { drystand: "c", dewateringDepth: null, bioInfection: "b", unclassified: null } },
        b2: { address: "Voorbeeldstraat 3", risk: { drystand: null, dewateringDepth: null, bioInfection: null, unclassified: null } },
      } },
      new Map([
        ["b1", { drystand: null, dewateringDepth: "b", bioInfection: null, unclassified: "d" }],
        ["b2", { drystand: "a", dewateringDepth: null, bioInfection: "a", unclassified: null }],
      ]),
    );
    const line = riskChangedLine(changes);
    expect(line).toBe(
      "Funderingsrisico herberekend: Voorbeeldstraat 1 – droogstand C → niet van toepassing, ontwateringsdiepte niet van toepassing → B, " +
        "bacteriële aantasting B → niet van toepassing, vastgesteld risico niet vastgesteld → D; " +
        "Voorbeeldstraat 3 – droogstand niet bepaald → A, bacteriële aantasting niet bepaald → A",
    );
    const mail = buildRiskChangedEmail({ reference: "FM2026-000042", recipientName: "", changes, statusUrl: "https://x", replyTo: "y" });
    const said = mail.text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.replace(/^- [^:]+: /, "").replace(/\.$/, ""));
    expect(said.length).toBe(6);
    for (const s of said) expect(line).toContain(s);
  });
});

describe("explainBasis: risk from a QuickScan (Don, 2026-10-02)", () => {
  test("says the risk follows the QuickScan and does not name the registered foundation type", () => {
    const lines = explainBasis(basis({ quickScanRisk: "b" }) as never);
    expect(lines[0]).toContain("Verkennend Funderingsonderzoek (QuickScan)");
    expect(lines[0]).toContain("B");
    expect(lines.join(" ")).not.toContain("Funderingstype:");
  });
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
  test("everything A: no 'hoogste risico A'", () => {
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
  test("one list in one style: the risks read like the onderbouwing under them", () => {
    expect(mail.text).toContain(
      "\n\nSpaarne 67C, 2011 CH Haarlem:\n\n" +
        "- Droogstand: B.\n" +
        "- Ontwateringsdiepte: D.\n" +
        "- Bacteriële aantasting: C.\n" +
        "- Gebaseerd op: ",
    );
    const items = mail.text.split("\n").filter((line) => line.startsWith("- "));
    expect(items.length).toBe(6);
    for (const item of items) expect(item).toMatch(/^- \p{Lu}.*\.$/u);
  });
  test("a vastgesteld risico and 'niet van toepassing' follow the same style", () => {
    const other = buildRiskConfirmedEmail({
      reference: "FM2026-000000", recipientName: "",
      buildings: [{ address: "Voorbeeldstraat 3", risk: { drystand: null, dewateringDepth: "d", bioInfection: null, unclassified: "d" }, basis: null }],
      statusUrl: "https://x", replyTo: "y",
    });
    expect(other.text).toContain(
      "\n\nVoorbeeldstraat 3:\n\n" +
        "- Droogstand: niet van toepassing.\n" +
        "- Ontwateringsdiepte: D.\n" +
        "- Bacteriële aantasting: niet van toepassing.\n" +
        "- Vastgesteld risico: D.\n" +
        "- Voor dit pand is op dit moment geen risicoberekening beschikbaar.\n\n",
    );
  });
  test("leaves out 'dagelijks herberekend' (Don: it invites 'wanneer dan wel?')", () => {
    expect(mail.text).not.toContain("dagelijks");
  });
  test("invites a newer document or a herstel by reply", () => {
    expect(mail.text).toContain("hersteld");
  });
});

describe("the Verloop lines of the follow-up (the melder's status page shows them too)", () => {
  test("unchanged: a dash after the address, so the explanation's colon is the only one", () => {
    const line = riskUnchangedLine([
      { address: "Voorbeeldstraat 1, 1234 AB Voorbeeldstad", basis: basis({ quickScanRisk: "b" }) as never },
    ]);
    expect(line).toBe(
      "Funderingsrisico herberekend: ongewijzigd. Voorbeeldstraat 1, 1234 AB Voorbeeldstad – " +
        "Gebaseerd op: het Verkennend Funderingsonderzoek (QuickScan) van dit pand, uitkomst B. Het funderingsrisico volgt deze uitkomst. " +
        "Het hoogste risico komt uit de ontwateringsdiepte (1,27 m): D.",
    );
    expect(line).not.toContain("Voorbeeldstad: ");
  });

  test("unchanged, several addresses: the same for each", () => {
    const line = riskUnchangedLine([
      { address: "Voorbeeldstraat 1", basis: basis() as never },
      { address: "Voorbeeldstraat 3", basis: null },
    ]);
    expect(line).toStartWith('Funderingsrisico herberekend: ongewijzigd. Voorbeeldstraat 1 – Gebaseerd op: archiefonderzoek "Funderingskaart Haarlem" (2025). ');
    expect(line).not.toMatch(/Voorbeeldstraat \d: /);
  });

  // Every explanation ends in a full stop, so "; " between two addresses gave ".; ".
  test("unchanged, several addresses: a space between them, no '.;'", () => {
    const line = riskUnchangedLine([
      { address: "Voorbeeldstraat 1", basis: basis({ quickScanRisk: "b" }) as never },
      { address: "Voorbeeldstraat 3", basis: basis({ drystandRisk: "a", dewateringDepthRisk: "a", bioInfectionRisk: "a" }) as never },
      { address: "Voorbeeldstraat 5", basis: null },
    ]);
    expect(line).toBe(
      "Funderingsrisico herberekend: ongewijzigd. " +
        "Voorbeeldstraat 1 – Gebaseerd op: het Verkennend Funderingsonderzoek (QuickScan) van dit pand, uitkomst B. Het funderingsrisico volgt deze uitkomst. " +
        "Het hoogste risico komt uit de ontwateringsdiepte (1,27 m): D. " +
        'Voorbeeldstraat 3 – Gebaseerd op: archiefonderzoek "Funderingskaart Haarlem" (2025). Funderingstype: houten palen. Geen van de onderdelen geeft een verhoogd risico. ' +
        "Voorbeeldstraat 5 – Voor dit pand is op dit moment geen risicoberekening beschikbaar.",
    );
    expect(line).not.toContain(".;");
    expect(line).not.toContain(";");
  });

  // The rule the join relies on.
  test("every line of an explanation ends in a full stop", () => {
    const variants = [
      null,
      basis(),
      basis({ quickScanRisk: "c" }),
      basis({ inquiryType: null, documentName: null, foundationTypeReliability: "cluster" }),
      basis({ inquiryType: null, documentName: null, foundationTypeReliability: "indicative" }),
      basis({ drystandRisk: "d" }),
      basis({ drystandRisk: "d", bioInfectionRisk: "d" }),
      basis({ drystandRisk: "a", dewateringDepthRisk: "a", bioInfectionRisk: "a" }),
      basis({ drystandRisk: "a", dewateringDepthRisk: "a", bioInfectionRisk: "e" }),
      basis({ documentName: null, documentDate: null }),
      basis({ foundationType: null, drystandRisk: null, dewateringDepthRisk: null, bioInfectionRisk: null }),
    ];
    for (const b of variants) {
      const lines = explainBasis(b as never);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toEndWith(".");
    }
  });

  test("changed: the same dash between the address and what changed", () => {
    const line = riskChangedLine([
      { buildingId: "b1", address: "Voorbeeldstraat 1", fields: [{ label: "droogstand", before: "c", after: "e" }, { label: "vastgesteld risico", before: null, after: "d" }] },
      { buildingId: "b3", address: "Voorbeeldstraat 3", fields: [{ label: "ontwateringsdiepte", before: "b", after: "a" }] },
    ]);
    expect(line).toBe(
      "Funderingsrisico herberekend: Voorbeeldstraat 1 – droogstand C → E, vastgesteld risico niet vastgesteld → D; Voorbeeldstraat 3 – ontwateringsdiepte B → A",
    );
  });
});

describe("buildRiskChangedEmail: pile-only risks falling away", () => {
  const base = {
    reference: "FM2026-000282",
    recipientName: "H. de Graaf",
    statusUrl: "https://melden.fundermaps.com/melding/FM2026-000282",
    replyTo: "melding+FM2026-000282@funderdata.nl",
  };

  test("explains why when droogstand or bacteriële aantasting becomes niet bepaald", () => {
    const mail = buildRiskChangedEmail({
      ...base,
      changes: [{ buildingId: "b7", address: "Spieghelstraat 7, 3521 XL Utrecht", fields: [
        { label: "droogstand", before: "c", after: null },
        { label: "ontwateringsdiepte", before: null, after: "b" },
        { label: "bacteriële aantasting", before: "d", after: null },
      ] }],
    });
    expect(mail.text).toContain("alleen voor een fundering op houten palen");
  });

  test("says nothing extra when no pile-only risk falls away", () => {
    const mail = buildRiskChangedEmail({
      ...base,
      changes: [{ buildingId: "b2", address: "Molenwal 15", fields: [{ label: "droogstand", before: "c", after: "e" }] }],
    });
    expect(mail.text).not.toContain("houten palen");
  });
});
