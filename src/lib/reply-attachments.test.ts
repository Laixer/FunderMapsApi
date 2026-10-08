import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { sortAttachments } = await import("./reply-attachments.ts");

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
