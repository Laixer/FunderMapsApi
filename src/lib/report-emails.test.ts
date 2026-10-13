import { describe, test, expect } from "bun:test";

// config.ts parses process.env at import time; the db client is lazy and no
// test here opens a connection or sends anything: only the builders run.
process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { env } = await import("../config.ts");
const {
  buildApprovedEmail,
  buildRejectedEmail,
  buildReviewRequestedEmail,
  contactOf,
  reportParties,
} = await import("./report-emails.ts");

const ctx = {
  kind: "inquiry" as const,
  id: 4821,
  documentName: "Funderingsonderzoek Voorbeeldstraat 1.pdf",
  creatorEmail: "sanne@bureau.test",
  creatorName: "Sanne Bakker",
  reviewerEmail: "pieter@bureau.test",
  reviewerName: "Pieter Jansen",
  organizationName: "Bureau Voorbeeld B.V.",
};
const url = `${env.STUDIO_URL}/inquiry/4821`;
const all = (c: typeof ctx | (Omit<typeof ctx, "kind"> & { kind: "recovery" })) => [
  buildReviewRequestedEmail(c),
  buildApprovedEmail(c),
  buildRejectedEmail({ ...c, motivation: "Onvolledig." }),
];

describe("who the mail names (never an e-mail address)", () => {
  // What the routes have in hand: the attribution view, whose *Name fields are
  // e-mail addresses, and the accounts looked up by id.
  const attr = { creator: "c-1", creatorName: "sanne@bureau.test", reviewer: "r-1", reviewerName: "pieter@bureau.test" };

  const sanne = (givenName: string | null, lastName: string | null) =>
    contactOf({ email: "sanne@bureau.test", givenName, lastName });
  const pieter = (givenName: string | null, lastName: string | null) =>
    contactOf({ email: "pieter@bureau.test", givenName, lastName });

  test("a name is the given and the family name", () => {
    expect(sanne("Sanne", "Bakker")).toEqual({ email: "sanne@bureau.test", name: "Sanne Bakker" });
    expect(sanne(" Sanne ", null).name).toBe("Sanne");
    expect(sanne(null, "Bakker").name).toBe("Bakker");
  });

  test("no name stored gives an empty name, not the address", () => {
    expect(sanne(null, null)).toEqual({ email: "sanne@bureau.test", name: "" });
    expect(sanne("", "  ").name).toBe("");
  });

  test("accounts with a name: greeted and named by it", () => {
    const contacts = new Map([["c-1", sanne("Sanne", "Bakker")], ["r-1", pieter("Pieter", "Jansen")]]);
    const parties = reportParties(attr, contacts);
    expect(parties).toEqual({
      creatorEmail: "sanne@bureau.test",
      creatorName: "Sanne Bakker",
      reviewerEmail: "pieter@bureau.test",
      reviewerName: "Pieter Jansen",
    });

    const review = buildReviewRequestedEmail({ ...ctx, ...parties });
    expect(review.to).toEqual(["Pieter Jansen <pieter@bureau.test>"]);
    expect(review.text).toStartWith("Beste Pieter Jansen,\n\n");
    expect(review.text).toContain('Sanne Bakker (Bureau Voorbeeld B.V.) heeft het onderzoeksrapport "Funderingsonderzoek Voorbeeldstraat 1.pdf" ter review aangeboden.');

    const rejected = buildRejectedEmail({ ...ctx, ...parties, motivation: "Onvolledig." });
    expect(rejected.to).toEqual(["Sanne Bakker <sanne@bureau.test>", "Pieter Jansen <pieter@bureau.test>"]);
    expect(rejected.text).toStartWith("Beste Sanne Bakker,\n\n");
    expect(rejected.text).toContain("is afgekeurd door Pieter Jansen.");
    expect(buildApprovedEmail({ ...ctx, ...parties }).text).toContain("is goedgekeurd door Pieter Jansen.");
  });

  test("accounts without a name: the fallback words, and the mail still goes to the same addresses", () => {
    const contacts = new Map([["c-1", sanne(null, null)], ["r-1", pieter(null, null)]]);
    const parties = reportParties(attr, contacts);
    expect(parties.creatorName).toBe("");
    expect(parties.reviewerName).toBe("");

    const review = buildReviewRequestedEmail({ ...ctx, ...parties });
    expect(review.to).toEqual(["pieter@bureau.test"]);
    expect(review.text).toStartWith("Beste reviewer,\n\n");
    expect(review.text).toContain("Een collega (Bureau Voorbeeld B.V.) heeft het onderzoeksrapport");

    const approved = buildApprovedEmail({ ...ctx, ...parties });
    expect(approved.to).toEqual(["sanne@bureau.test", "pieter@bureau.test"]);
    expect(approved.text).toStartWith("Beste collega,\n\n");
    expect(approved.text).toContain("is goedgekeurd door de reviewer.");
    expect(buildRejectedEmail({ ...ctx, ...parties, motivation: "Onvolledig." }).text).toContain("is afgekeurd door de reviewer.");

    // No address anywhere in the words, in either rendering.
    for (const mail of all({ ...ctx, ...parties })) {
      expect(mail.text).not.toContain("@");
      expect(mail.html).not.toContain("@");
    }
  });

  test("an id without an account (deleted) is left out of the recipients", () => {
    const parties = reportParties(attr, new Map([["c-1", sanne("Sanne", "Bakker")]]));
    expect(parties.reviewerEmail).toBe("");
    expect(buildReviewRequestedEmail({ ...ctx, ...parties }).to).toEqual([]);
    expect(buildApprovedEmail({ ...ctx, ...parties }).to).toEqual(["Sanne Bakker <sanne@bureau.test>"]);
  });

  test("a name cannot break the recipient it stands in front of", () => {
    const mail = buildReviewRequestedEmail({ ...ctx, reviewerName: 'Jansen, P. (Pieter) <"de reviewer">' });
    expect(mail.to).toEqual(["Jansen P. Pieter de reviewer <pieter@bureau.test>"]);
    // The words keep the name as it is stored.
    expect(mail.text).toStartWith('Beste Jansen, P. (Pieter) <"de reviewer">,\n\n');
  });
});

describe("the words of the three mails", () => {
  test("a missing organisation or name leaves no hole in the sentence", () => {
    const review = buildReviewRequestedEmail({ ...ctx, organizationName: "" });
    expect(review.text).toContain("Sanne Bakker heeft het onderzoeksrapport");
    expect(buildReviewRequestedEmail({ ...ctx, creatorName: "", organizationName: "" }).text).toContain(
      "\n\nEen collega heeft het onderzoeksrapport",
    );
    for (const mail of all({ ...ctx, creatorName: "", reviewerName: "", organizationName: "" })) {
      expect(mail.text).not.toContain("()");
      expect(mail.text).not.toContain("door .");
      expect(mail.text).not.toMatch(/\n /);
      expect(mail.html).not.toContain("()");
    }
  });

  test("the app is called the FunderMaps Studio", () => {
    const review = buildReviewRequestedEmail(ctx);
    expect(review.text).toContain("Open het rapport in de FunderMaps Studio om het te beoordelen:");
    expect(review.text).not.toContain("Data Studio");
  });

  test("the subject names what the body is about", () => {
    expect(all(ctx).map((m) => m.subject)).toEqual([
      "FunderMaps - Rapportage ter review",
      "FunderMaps - Rapportage is goedgekeurd",
      "FunderMaps - Rapportage is afgekeurd",
    ]);
    const herstel = all({ ...ctx, kind: "recovery" });
    expect(herstel.map((m) => m.subject)).toEqual([
      "FunderMaps - Herstelrapport ter review",
      "FunderMaps - Herstelrapport is goedgekeurd",
      "FunderMaps - Herstelrapport is afgekeurd",
    ]);
    for (const mail of herstel) expect(mail.text).toContain("herstelrapport");
  });

  test("the text ends like every other mail: the link, one blank line, the greeting", () => {
    for (const mail of all(ctx)) {
      expect(mail.text).toEndWith(`:\n\n${url}\n\nMet vriendelijke groet,\nFunderMaps`);
      expect(mail.text).not.toContain("\n\n\n");
    }
  });
});

describe("the HTML version", () => {
  test("keeps the lines of a motivation apart", () => {
    const motivation = "Drie punten:\n1. Paalkopniveau ontbreekt.\n2. Bouwjaar klopt niet.";
    const mail = buildRejectedEmail({ ...ctx, motivation });
    expect(mail.text).toContain(`Motivatie: ${motivation}\n\n`);
    expect(mail.html).toContain("<p>Motivatie: Drie punten:<br>1. Paalkopniveau ontbreekt.<br>2. Bouwjaar klopt niet.</p>");
    expect(mail.html).not.toContain("\n");
  });

  test("lets a long file name wrap instead of widening the mail", () => {
    for (const mail of all({ ...ctx, documentName: `${"Funderingsonderzoek_".repeat(8)}.pdf` })) {
      expect(mail.html).toMatch(/^<div style="[^"]*overflow-wrap:anywhere;word-break:break-word">/);
    }
  });

  test("escapes what people typed and links the report", () => {
    const mail = buildRejectedEmail({ ...ctx, documentName: 'a<b> & "c".pdf', motivation: "Zie <bijlage> & tabel" });
    expect(mail.html).toContain("a&lt;b&gt; &amp; &quot;c&quot;.pdf");
    expect(mail.html).toContain("Motivatie: Zie &lt;bijlage&gt; &amp; tabel");
    expect(mail.html).toContain(`<p><a href="${url}">${url}</a></p>`);
    expect(mail.html).toEndWith("<p>Met vriendelijke groet,<br>FunderMaps</p></div>");
  });
});
