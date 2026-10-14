import { describe, test, expect } from "bun:test";

// config.ts parses process.env at import time; the db client is lazy and no
// test here opens a connection.
process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const {
  addressLine,
  displayFilename,
  addBusinessDays,
  isDutchPublicHoliday,
  buildClosedEmail,
  buildMelderMessage,
  buildReceivedEmail,
  compareWithRegistered,
  formatDayNl,
  formatFieldValue,
  localDay,
  RESPONSE_BUSINESS_DAYS,
} = await import("./intake-emails.ts");

const { nummeraanduidingOf } = await import("./geocoder-id.ts");
const { referenceOf } = await import("../routes/webhooks.ts");

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("addBusinessDays", () => {
  test("mid-week: two working days later", () => {
    // Wed 2026-09-02 -> Fri 2026-09-04
    expect(iso(addBusinessDays(new Date("2026-09-02T10:00:00Z"), 2))).toBe("2026-09-04");
  });

  test("Friday skips the weekend", () => {
    expect(iso(addBusinessDays(new Date("2026-09-04T10:00:00Z"), 2))).toBe("2026-09-08");
  });

  test("weekend counts from Monday", () => {
    expect(iso(addBusinessDays(new Date("2026-09-05T10:00:00Z"), 2))).toBe("2026-09-08");
    expect(iso(addBusinessDays(new Date("2026-09-06T10:00:00Z"), 2))).toBe("2026-09-08");
  });

  test("the day is the Amsterdam day, not the UTC day", () => {
    // 22:30Z on Thursday is 00:30 Friday in Amsterdam (CEST) -> Tuesday.
    expect(iso(addBusinessDays(new Date("2026-09-03T22:30:00Z"), 2))).toBe("2026-09-08");
    // Thursday noon stays Thursday -> Monday.
    expect(iso(addBusinessDays(new Date("2026-09-03T12:00:00Z"), 2))).toBe("2026-09-07");
  });

  test("the promise is two working days", () => {
    expect(RESPONSE_BUSINESS_DAYS).toBe(2);
  });

  test("Dutch national holidays do not count (Don, 2026-09-06)", () => {
    // Thu 2026-04-02 -> Fri 3 April is Good Friday, Mon 6 April is Easter Monday -> Wed 8 April.
    expect(iso(addBusinessDays(new Date("2026-04-02T10:00:00Z"), 2))).toBe("2026-04-08");
    // Wed 2026-12-23 -> Thu 24 counts, Christmas Fri+Sat, Sun -> Mon 28.
    expect(iso(addBusinessDays(new Date("2026-12-23T10:00:00Z"), 2))).toBe("2026-12-28");
    // Thu 2026-04-23 -> Fri 24, Mon 27 April is Koningsdag -> Tue 28.
    expect(iso(addBusinessDays(new Date("2026-04-23T10:00:00Z"), 2))).toBe("2026-04-28");
  });
});

describe("isDutchPublicHoliday", () => {
  const day = (s: string) => new Date(`${s}T00:00:00Z`);
  test("movable feasts for 2026 (Easter 5 April)", () => {
    for (const d of ["2026-04-03", "2026-04-05", "2026-04-06", "2026-05-14", "2026-05-24", "2026-05-25"]) {
      expect(isDutchPublicHoliday(day(d))).toBe(true);
    }
  });
  test("fixed days and Koningsdag", () => {
    for (const d of ["2026-01-01", "2026-04-27", "2026-05-05", "2026-12-25", "2026-12-26", "2025-04-26"]) {
      expect(isDutchPublicHoliday(day(d))).toBe(true);
    }
    // 27 April 2025 was a Sunday -> Koningsdag moved to Saturday the 26th.
    expect(isDutchPublicHoliday(day("2025-04-27"))).toBe(false);
  });
  test("ordinary days are not holidays", () => {
    for (const d of ["2026-09-07", "2026-04-04", "2026-05-13", "2026-12-24"]) {
      expect(isDutchPublicHoliday(day(d))).toBe(false);
    }
  });
});

describe("formatDayNl", () => {
  test("Dutch long date with weekday", () => {
    expect(formatDayNl(localDay(new Date("2026-09-08T10:00:00Z")))).toBe("dinsdag 8 september 2026");
  });
});

describe("formatFieldValue", () => {
  test("foundation type in words", () => {
    expect(formatFieldValue("foundation_type", "wood_amsterdam")).toBe(
      "houten palen (Amsterdamse fundering)",
    );
  });
  test("levels get their unit", () => {
    expect(formatFieldValue("wood_level", "-1.85")).toBe("-1,85 m NAP");
  });
  test("measurements read with a decimal comma, like the rest of the mails", () => {
    expect(formatFieldValue("groundwater_level", "-1.6")).toBe("-1,6 m NAP");
    expect(formatFieldValue("settlement_speed", "1.2")).toBe("1,2 mm per jaar");
    expect(formatFieldValue("pile_diameter_top", "180")).toBe("180 mm");
    // A number without a unit of its own is still a number.
    expect(formatFieldValue("some_measurement", "-0.35")).toBe("-0,35");
  });
  // A scheefstand is stored as the n of a 1:n ratio (Don, 2026-09-11) and the Studio, the map app and the
  // PDF report show it as that ratio: "1:300". The mail said "300 mm/m", a unit that was simply wrong.
  test("a lintvoegmeting or loodmeting is the ratio, as the Studio, the map and the PDF show it", () => {
    for (const field of ["skewed_parallel", "skewed_perpendicular"]) {
      expect(formatFieldValue(field, "300")).toBe("1:300");
      expect(formatFieldValue(field, "1117")).toBe("1:1117");
      expect(formatFieldValue(field, " 250 ")).toBe("1:250");
      // The n as the map and the PDF print it: a whole number.
      expect(formatFieldValue(field, "275.5")).toBe("1:276");
      expect(formatFieldValue(field, "275,5")).toBe("1:276");
      expect(formatFieldValue(field, "300.00")).toBe("1:300");
      // Anything but a bare number stays as it was recorded, and gets no unit.
      expect(formatFieldValue(field, "1:300")).toBe("1:300");
      expect(formatFieldValue(field, "niet gemeten")).toBe("niet gemeten");
      expect(formatFieldValue(field, "-300")).toBe("-300");
    }
  });
  // The map app, the Studio and the PDF report show a drempelniveau in metres relative to NAP.
  test("a drempelniveau is a level like the others: metres NAP", () => {
    expect(formatFieldValue("threshold_front_level", "-0.35")).toBe("-0,35 m NAP");
    expect(formatFieldValue("threshold_back_level", "0.4")).toBe("0,4 m NAP");
    expect(formatFieldValue("threshold_back_level", "-1")).toBe("-1 m NAP");
    // Words stay as they were recorded, without a unit behind them.
    expect(formatFieldValue("threshold_front_level", "gelijk aan maaiveld")).toBe("gelijk aan maaiveld");
  });
  test("a full stop in words is not a decimal point", () => {
    expect(formatFieldValue("recovery_note", "Zie rapport v1.2, par. 3.4.")).toBe("Zie rapport v1.2, par. 3.4.");
    expect(formatFieldValue("contractor", "Bureau 2.0 B.V.")).toBe("Bureau 2.0 B.V.");
    expect(formatFieldValue("document_date", "3.11.2014")).toBe("3.11.2014");
  });
  test("booleans and terms read as Dutch", () => {
    expect(formatFieldValue("recovery_advised", "true")).toBe("ja");
    expect(formatFieldValue("enforcement_term", "term510")).toBe("5-10 jaar");
  });
  test("quality, damage cause and damage characteristics read as Dutch", () => {
    expect(formatFieldValue("foundation_quality", "mediocre")).toBe("matig");
    expect(formatFieldValue("foundation_quality", "mediocre_bad")).toBe("matig tot slecht");
    expect(formatFieldValue("damage_cause", "drainage")).toBe("ontwatering");
    expect(formatFieldValue("damage_cause", "negative_cling")).toBe("negatieve kleef");
    expect(formatFieldValue("damage_characteristics", "jamming_door_window")).toBe("klemmende deuren en ramen");
  });
  test("unknown values fall back to the recorded text", () => {
    expect(formatFieldValue("damage_cause", "meteorite")).toBe("meteorite");
    expect(formatFieldValue("substructure", "some_thing")).toBe("some thing");
  });
});

describe("buildMelderMessage (API #209)", () => {
  test("a question reads as a question, as before", () => {
    const mail = buildMelderMessage("question", "FM2026-000042", "Jan Poland", "Welk jaar is het pand gebouwd?");
    expect(mail.subject).toBe("FunderMaps - Vraag over uw melding FM2026-000042");
    expect(mail.text).toContain("Beste Jan Poland,");
    expect(mail.text).toContain("hebben wij een vraag:");
    expect(mail.text).toContain("Welk jaar is het pand gebouwd?");
  });

  // "Dossier" is the word staff use; every other mail to a melder says "uw melding".
  test("a reply is linked to 'uw melding', in the words of the other melder mails", () => {
    const question = buildMelderMessage("question", "FM2026-000042", "Jan Poland", "Welk jaar is het pand gebouwd?");
    expect(question.text).toContain(
      "\n\nU kunt deze e-mail direct beantwoorden; uw antwoord wordt automatisch aan uw melding gekoppeld.\n\n",
    );
    const answer = buildMelderMessage("answer", "FM2026-000042", "Jan Poland", "Het risico is berekend.");
    expect(answer.text).toContain(
      "\n\nHeeft u nog een vraag? U kunt deze e-mail direct beantwoorden; uw reactie wordt automatisch aan uw melding gekoppeld.\n\n",
    );
    for (const mail of [question, answer]) {
      expect(mail.text.toLowerCase()).not.toContain("dossier");
      expect(mail.html.toLowerCase()).not.toContain("dossier");
      expect(mail.html).toContain("automatisch aan uw melding gekoppeld.</p>");
    }
  });

  test("an answer never says we have a question", () => {
    const mail = buildMelderMessage("answer", "FM2026-000042", "", "Het risico is berekend op het funderingsonderzoek uit 2021.");
    expect(mail.subject).toBe("FunderMaps - Reactie op uw melding FM2026-000042");
    expect(mail.text).toContain("Beste melder,");
    expect(mail.text).toContain("Naar aanleiding van uw melding FM2026-000042:");
    expect(mail.text).toContain("Het risico is berekend op het funderingsonderzoek uit 2021.");
    expect(mail.text).toContain("U kunt deze e-mail direct beantwoorden");
    expect(mail.text).not.toContain("vraag:");
    expect(mail.text).toContain("/melding/FM2026-000042");
  });

  // The subject is only the reply router's second resort (the reply address
  // carries the code), but a reply must keep finding its dossier by it.
  test("a reply to either still routes to its dossier by the subject alone", () => {
    for (const kind of ["question", "answer"] as const) {
      const { subject } = buildMelderMessage(kind, "FM2026-000042", "Jan Poland", "Tekst");
      expect(subject).toStartWith("FunderMaps - ");
      for (const prefix of ["", "Re: ", "RE: ", "Antw: ", "FW: Re: "]) {
        expect(referenceOf({ subject: prefix + subject })).toBe("FM2026-000042");
      }
    }
    expect(referenceOf({ subject: "FunderMaps - zonder meldcode" })).toBeNull();
  });
});

describe("buildReceivedEmail", () => {
  const input = {
    reference: "FM2026-000042",
    recipientName: "Jan Poland",
    address: "Jollenpad 13, 1081 KC Amsterdam",
    receivedAt: new Date("2026-09-03T12:00:00Z"),
    files: [
      { name: "Februari 1980 heien Jollenpad 13.pdf", category: "archieveresearch" },
      { name: "foto <voorgevel>.jpg", category: "foto" },
    ],
    statusUrl: "https://melden.fundermaps.com/melding/FM2026-000042",
    replyTo: "melding+FM2026-000042@funderdata.nl",
  };

  test("carries meldcode, files with count, deadline, status link and reply address", () => {
    const mail = buildReceivedEmail(input);
    expect(mail.subject).toBe("FunderMaps - Uw melding FM2026-000042 is ontvangen");
    expect(mail.text).toContain("Beste Jan Poland,");
    expect(mail.text).toContain("Uw meldcode is FM2026-000042.");
    expect(mail.text).toContain("Jollenpad 13, 1081 KC Amsterdam");
    expect(mail.text).toContain("Ontvangen bestanden (2):");
    expect(mail.text).toContain("- Februari 1980 heien Jollenpad 13.pdf (bouwtekening / archiefstuk)");
    expect(mail.text).toContain("- foto <voorgevel>.jpg (foto's van de woning)");
    expect(mail.text).toContain("Wat gebeurt er nu? Een medewerker van FunderMaps beoordeelt uw melding en de meegestuurde documenten. ");
    expect(mail.text).toContain("U hoort uiterlijk maandag 7 september 2026 van ons.");
    expect(mail.text).toContain("https://melden.fundermaps.com/melding/FM2026-000042");
    // The address carries the meldcode; the mail does not ask for it again.
    expect(mail.text).toContain("\n\nVragen over uw melding? Stuur een e-mail naar melding+FM2026-000042@funderdata.nl.\n\n");
    expect(mail.text).not.toContain("vermeld daarbij uw meldcode");
    expect(mail.text.trimEnd().endsWith("Met vriendelijke groet,\nFunderMaps")).toBe(true);
  });

  test("HTML escapes filenames and links the status page", () => {
    const mail = buildReceivedEmail(input);
    expect(mail.html).toContain("<li>foto &lt;voorgevel&gt;.jpg (foto&#39;s van de woning)</li>".replace("&#39;", "'"));
    expect(mail.html).toContain(
      '<a href="https://melden.fundermaps.com/melding/FM2026-000042">https://melden.fundermaps.com/melding/FM2026-000042</a>',
    );
    expect(mail.html).not.toContain("<voorgevel>");
  });

  test("HTML lets a long file name or a BAG id wrap instead of widening the mail", () => {
    const mail = buildReceivedEmail({
      ...input,
      address: "NL.IMBAG.NUMMERAANDUIDING.0363200000123456",
      files: [{ name: `${"Funderingsonderzoek_".repeat(8)}.pdf`, category: null }],
    });
    expect(mail.html).toMatch(/^<div style="[^"]*overflow-wrap:anywhere;word-break:break-word">/);
  });

  test("no files says so, and a nameless melder is still greeted", () => {
    const mail = buildReceivedEmail({ ...input, recipientName: "", files: [] });
    expect(mail.text).toContain("Beste melder,");
    expect(mail.text).toContain("U heeft geen bestanden meegestuurd.");
    expect(mail.text).not.toContain("Ontvangen bestanden");
    // Nothing was sent along, so there are no documents to look at.
    expect(mail.text).toContain("Wat gebeurt er nu? Een medewerker van FunderMaps beoordeelt uw melding. Gegevens over de fundering");
    expect(mail.text).not.toContain("meegestuurde documenten");
  });
});

describe("compareWithRegistered", () => {
  const reg = { foundationType: "concrete", foundationTypeReliability: "indicative", constructionYear: 1932 };

  test("foundation type against the model", () => {
    expect(compareWithRegistered({ field: "foundation_type", value: "wood" }, reg)).toMatchObject({
      registered: "concrete",
      registeredReliability: "indicative",
      comparison: "differs",
    });
    expect(compareWithRegistered({ field: "foundation_type", value: "concrete" }, reg).comparison).toBe("same");
  });

  test("build year against the model", () => {
    expect(compareWithRegistered({ field: "built_year", value: "1932" }, reg).comparison).toBe("same");
    expect(compareWithRegistered({ field: "built_year", value: "1928" }, reg)).toMatchObject({
      registered: "1932",
      comparison: "differs",
    });
  });

  test("fields with no registered counterpart, or no model row, are not compared", () => {
    expect(compareWithRegistered({ field: "wood_level", value: "-1.2" }, reg).comparison).toBe("none");
    expect(compareWithRegistered({ field: "foundation_type", value: "wood" }, undefined).comparison).toBe("none");
  });
});

describe("buildClosedEmail", () => {
  const base = {
    reference: "FM2026-000042",
    recipientName: "Jan Poland",
    statusUrl: "https://melden.fundermaps.com/melding/FM2026-000042",
    replyTo: "melding+FM2026-000042@funderdata.nl",
  };

  test("accepted: per address what was taken over, how it compares, and the risk", () => {
    const mail = buildClosedEmail({
      ...base,
      outcome: "accepted",
      note: null,
      hasInquiry: true,
      addresses: [
        {
          address: "Jollenpad 13, 1081 KC Amsterdam",
          fields: [
            {
              field: "foundation_type",
              value: "wood",
              registered: "concrete",
              registeredReliability: "indicative",
              comparison: "differs",
            },
            { field: "built_year", value: "1932", registered: "1932", comparison: "same" },
            { field: "wood_level", value: "-1.85", registered: null, comparison: "none" },
          ],
          risk: { drystand: "b", dewateringDepth: "c", bioInfection: "a", unclassified: null },
        },
      ],
    });
    expect(mail.subject).toBe("FunderMaps - Uw melding FM2026-000042 is verwerkt");
    expect(mail.text).toContain("Uw melding met meldcode FM2026-000042 is verwerkt.");
    expect(mail.text).toContain("Dit hebben wij overgenomen in de Funderingsdatabase:");
    expect(mail.text).toContain("Jollenpad 13, 1081 KC Amsterdam:");
    expect(mail.text).toContain("- Funderingstype: houten palen; bij ons stond: betonnen palen, indicatief\n");
    expect(mail.text).toContain("- Bouwjaar: 1932; komt overeen met wat bij ons geregistreerd stond\n");
    expect(mail.text).toContain("- Niveau bovenkant langshout: -1,85 m NAP");
    expect(mail.text).toContain(
      "Funderingsrisico zoals nu bij ons geregistreerd: droogstand B, ontwateringsdiepte C, bacteriële aantasting A.",
    );
    expect(mail.text).toContain("kan het risico daardoor veranderen");
    expect(mail.text).toContain(base.statusUrl);
  });

  test("a foundation type with a bracket of its own is not followed by a second bracket", () => {
    const mail = buildClosedEmail({
      ...base,
      outcome: "accepted",
      note: null,
      hasInquiry: true,
      addresses: [
        {
          address: "Voorbeeldstraat 1, 1234 AB Voorbeeldstad",
          fields: [{ field: "foundation_type", value: "no_pile", registered: "no_pile", registeredReliability: "established", comparison: "same" }],
          risk: null,
        },
        {
          address: "Voorbeeldstraat 3, 1234 AB Voorbeeldstad",
          fields: [{ field: "foundation_type", value: "wood_amsterdam", registered: "wood", registeredReliability: "cluster", comparison: "differs" }],
          risk: null,
        },
        {
          address: "Voorbeeldstraat 5, 1234 AB Voorbeeldstad",
          fields: [{ field: "foundation_type", value: "wood", registered: null, comparison: "differs" }],
          risk: null,
        },
      ],
    });
    expect(mail.text).toContain("- Funderingstype: ondiepe fundering (op staal); komt overeen met wat bij ons geregistreerd stond\n");
    expect(mail.text).toContain("- Funderingstype: houten palen (Amsterdamse fundering); bij ons stond: houten palen, afgeleid\n");
    expect(mail.text).toContain("- Funderingstype: houten palen; bij ons stond: geen gegevens\n");
    expect(mail.text).not.toContain(") (");
    expect(mail.html).not.toContain(") (");
  });

  test("document facts once, units on measurements, unresolved addresses named (Don #321 §4/§5/§7)", () => {
    const mail = buildClosedEmail({
      ...base,
      outcome: "accepted",
      note: null,
      hasInquiry: true,
      document: [
        { field: "document_date", value: "2014-11-03", registered: null, comparison: "none" },
        { field: "inquiry_type", value: "foundation_research", registered: null, comparison: "none" },
        { field: "contractor", value: "Fugro GeoServices B.V.", registered: null, comparison: "none" },
      ],
      addresses: [
        {
          address: "Derde Schinkelstraat 14-22, Amsterdam",
          fields: [
            { field: "skewed_parallel", value: "300", registered: null, comparison: "none" },
            { field: "crack_facade_front_type", value: "mediocre", registered: null, comparison: "none" },
            { field: "wood_type", value: "spruce", registered: null, comparison: "none" },
          ],
          risk: null,
        },
      ],
      unresolved: ["Derde Schinkelstraat 14R", "Derde Schinkelstraat 14L"],
    });
    expect(mail.text).toContain("Over het document:");
    expect(mail.text).toContain("- Datum van het rapport: 3 november 2014");
    expect(mail.text).toContain("- Soort document: funderingsonderzoek");
    expect(mail.text).toContain("- Opgesteld door: Fugro GeoServices B.V.");
    expect(mail.text).toContain("- Lintvoegmeting: 1:300\n");
    expect(mail.text).not.toContain("mm/m");
    expect(mail.text).toContain("- Scheurvorming voorgevel: matig");
    expect(mail.text).toContain("- Houtsoort: vuren");
    expect(mail.text).toContain("niet aan een pand konden koppelen");
    expect(mail.text).toContain("- Derde Schinkelstraat 14L\n- Derde Schinkelstraat 14R");
    expect(mail.text).not.toContain("contractor");
    expect(mail.text).not.toContain("vermeld daarbij uw meldcode");
    expect(mail.text).toContain("Beantwoord deze e-mail.");
  });

  test("accepted with nothing differing says the risk is not expected to change", () => {
    const mail = buildClosedEmail({
      ...base,
      outcome: "accepted",
      note: null,
      hasInquiry: true,
      addresses: [
        {
          address: "Jollenpad 13, 1081 KC Amsterdam",
          fields: [{ field: "built_year", value: "1932", registered: "1932", comparison: "same" }],
          risk: null,
        },
      ],
    });
    expect(mail.text).toContain("Het risico verandert daardoor naar verwachting niet.");
    expect(mail.text).not.toContain("Funderingsrisico zoals nu");
  });

  test("rejected: the reviewer's note, and 'afgewezen' in the subject", () => {
    const mail = buildClosedEmail({
      ...base,
      outcome: "rejected",
      note: "Het document gaat over een ander pand.",
      hasInquiry: false,
      addresses: [],
    });
    expect(mail.subject).toBe("FunderMaps - Uw melding FM2026-000042 is afgewezen");
    expect(mail.text).toContain("Het document gaat over een ander pand.");
    expect(mail.text).not.toContain("overgenomen");
  });

  test("no_data and duplicate read as verwerkt, never as a fault", () => {
    const noData = buildClosedEmail({ ...base, outcome: "no_data", note: null, hasInquiry: false, addresses: [] });
    expect(noData.subject).toContain("is verwerkt");
    expect(noData.text).toContain("bevatte geen gegevens over de fundering");
    const dup = buildClosedEmail({ ...base, outcome: "duplicate", note: "Al bekend.", hasInquiry: false, addresses: [] });
    expect(dup.subject).toContain("is verwerkt");
    expect(dup.text).toContain("Al bekend.");
  });
});

describe("address and filename display", () => {
  test("postal code gets its space, missing parts are skipped", () => {
    expect(addressLine({ street: "Jollenpad", buildingNumber: "13", postalCode: "1081KC", city: "Amsterdam" })).toBe(
      "Jollenpad 13, 1081 KC Amsterdam",
    );
    expect(addressLine({ street: "Jollenpad", buildingNumber: "13", postalCode: null, city: "Amsterdam" })).toBe(
      "Jollenpad 13, Amsterdam",
    );
  });

  test("storage nonce prefix is stripped, nameless files get a word", () => {
    expect(displayFilename("56979f2cb13a52fd-DEST302655_1_.pdf")).toBe("DEST302655_1_.pdf");
    expect(displayFilename("Ordner1.pdf")).toBe("Ordner1.pdf");
    expect(displayFilename(null)).toBe("bestand");
  });
});

describe("describeOutcome hides the commit's internal note", () => {
  test("auto note falls back to the plain explanation", async () => {
    const { describeOutcome, isAutoCommitNote } = await import("./intake-outcome.ts");
    expect(isAutoCommitNote("Overgenomen als rapportage #157806")).toBe(true);
    // The multi-rapportage commit (API #232) writes its own staff note; it must not reach the melder either.
    expect(isAutoCommitNote("Overgenomen als 2 rapportages: #160622, #160623")).toBe(true);
    expect(isAutoCommitNote("Overgenomen; de tekening bevestigt houten palen.")).toBe(false);
    expect(describeOutcome("accepted", "Overgenomen als rapportage #157806", true).explanation).toBe(
      "De gegevens van dit pand zijn overgenomen in de Funderingsdatabase.",
    );
    expect(describeOutcome("accepted", "Bedankt, tekening overgenomen.", true).explanation).toBe(
      "Bedankt, tekening overgenomen.",
    );
  });
});

describe("describeOutcome: closed without a rapportage", () => {
  test("says nothing changed and nothing follows", async () => {
    const { describeOutcome, CLOSED_FOR_GOOD } = await import("./intake-outcome.ts");
    const d = describeOutcome("accepted", null, false);
    expect(d.state).toBe("afgehandeld en gesloten");
    expect(d.explanation).toContain("Er is niets gewijzigd in de Funderingsdatabase.");
    expect(d.explanation.endsWith(CLOSED_FOR_GOOD)).toBe(true);
  });

  test("keeps the reviewer's reason and adds the closing line", async () => {
    const { describeOutcome, CLOSED_FOR_GOOD } = await import("./intake-outcome.ts");
    const d = describeOutcome("accepted", "Uw pand staat al goed geregistreerd.", false);
    expect(d.explanation).toBe(`Uw pand staat al goed geregistreerd.\n\n${CLOSED_FOR_GOOD}`);
  });

  test("a committed melding is still 'verwerkt'", async () => {
    const { describeOutcome } = await import("./intake-outcome.ts");
    expect(describeOutcome("accepted", null, true).state).toBe("verwerkt");
  });
});

describe("nummeraanduidingOf", () => {
  // dossier.bag_id arrives in two shapes: 3,237 rows prefixed, 99 bare (#200).
  test("bare digits get the BAG prefix", () => {
    expect(nummeraanduidingOf("0718200000012476")).toBe(
      "NL.IMBAG.NUMMERAANDUIDING.0718200000012476",
    );
  });

  test("an already-prefixed id is left alone", () => {
    expect(nummeraanduidingOf("NL.IMBAG.NUMMERAANDUIDING.0718200000012476")).toBe(
      "NL.IMBAG.NUMMERAANDUIDING.0718200000012476",
    );
  });

  test("prefixing is not applied twice", () => {
    const once = nummeraanduidingOf("0003200000134166");
    expect(nummeraanduidingOf(once)).toBe(once);
  });
});
