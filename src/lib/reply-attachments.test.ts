import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { attachmentLines, sortAttachments } = await import("./reply-attachments.ts");

const a = (filename: string, content_type: string, size: number, content_disposition = "attachment") => ({ id: filename, filename, content_type, size, content_disposition });

describe("sortAttachments", () => {
  test("the cases seen on 2026-10-08: reports kept, mail logo and forwarded .eml left out", () => {
    const { keep, skipped } = sortAttachments([
      a("Rapport funderingsrisico.pdf", "application/pdf", 713_977),
      a("LOGO nieuw.jpg", "image/jpeg", 22_692),
      a("meldcode is FM2026-000494.eml", "message/rfc822", 1_168_204),
      a("031205 - Duyts Rapport.pdf", "application/pdf", 16_164_092),
    ]);
    expect(keep.map((k) => k.filename)).toEqual(["Rapport funderingsrisico.pdf", "031205 - Duyts Rapport.pdf"]);
    expect(skipped.map((s) => s.name)).toEqual(["LOGO nieuw.jpg", "meldcode is FM2026-000494.eml"]);
  });

  test("a large photo is a document; an inline image is not, whatever its size", () => {
    const { keep, skipped } = sortAttachments([
      a("scheur.jpg", "image/jpeg", 2_400_000),
      a("banner.png", "image/png", 400_000, "inline"),
    ]);
    expect(keep.map((k) => k.filename)).toEqual(["scheur.jpg"]);
    expect(skipped[0]!.name).toBe("banner.png");
  });

  test("empty files are left out", () => {
    expect(sortAttachments([a("leeg.pdf", "application/pdf", 0)]).keep).toHaveLength(0);
  });
});

describe("attachmentLines", () => {
  test("an attachment without a file name is not called 'undefined'", () => {
    // A forwarded mail arrives without a name, and the upload whitelist refuses its type.
    const { keep, skipped } = sortAttachments([
      { id: "1", content_type: "message/rfc822", size: 40_000 },
      a("LOGO nieuw.jpg", "image/jpeg", 22_692),
    ]);
    expect(keep).toHaveLength(0);
    const text = attachmentLines([], skipped);
    expect(text).toBe(
      "Niet opgeslagen: naamloze bijlage (soort bestand niet toegestaan (message/rfc822)), LOGO nieuw.jpg (afbeelding in de mail (logo of handtekening))",
    );
    expect(text).not.toContain("undefined");
    // Only the line names it; what is kept about the attachment is as it came in.
    expect(skipped[0]!.name).toBeUndefined();
  });

  test("a nameless attachment that is stored reads the same way, and is still stored", () => {
    const { keep } = sortAttachments([{ id: "2", content_type: "application/pdf", size: 700_000 }, a(" ", "application/pdf", 700_000)]);
    expect(keep).toHaveLength(2);
    expect(attachmentLines(keep.map((k) => ({ name: k.filename })), [])).toBe(
      "Bijlagen uit het antwoord opgeslagen: naamloze bijlage, naamloze bijlage",
    );
  });

  test("named files read as before: a line for what was stored, a line for what was not", () => {
    expect(attachmentLines([{ name: "a.pdf" }, { name: "b.pdf" }], [{ name: "c.eml", why: "te groot" }])).toBe(
      "Bijlagen uit het antwoord opgeslagen: a.pdf, b.pdf\nNiet opgeslagen: c.eml (te groot)",
    );
    expect(attachmentLines([{ name: "a.pdf" }], [])).toBe("Bijlage uit het antwoord opgeslagen: a.pdf");
  });
});
