import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { mergeToPdf, mergedName, mergeMime, UnmergeableDocumentError } from "./merge-documents.ts";

// A 1x1 PNG and a 2-page PDF made on the spot: no fixtures on disk.
const PNG_1PX = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function pdfWithPages(n: number) {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage();
  return d.save();
}

describe("mergeToPdf", () => {
  test("PDF pages are copied and each image becomes one page, in order", async () => {
    const merged = await mergeToPdf([
      { name: "a.pdf", mimeType: "application/pdf", bytes: await pdfWithPages(2) },
      { name: "b.png", mimeType: "image/png", bytes: PNG_1PX },
      { name: "c.pdf", mimeType: null, bytes: await pdfWithPages(1) },
    ]);
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(4);
  });

  test("a TIFF is refused by name", async () => {
    const err = await mergeToPdf([{ name: "NL-HlmNHA_0001.tif", mimeType: "image/tiff", bytes: new Uint8Array(4) }]).catch((e) => e);
    expect(err).toBeInstanceOf(UnmergeableDocumentError);
    expect((err as Error).message).toContain("NL-HlmNHA_0001.tif");
  });
});

describe("mergeMime", () => {
  test("falls back to the extension", () => {
    expect(mergeMime({ name: "scan.JPG", mimeType: null })).toBe("image/jpeg");
    expect(mergeMime({ name: "x.tif", mimeType: null })).toBeNull();
  });
});

describe("mergedName", () => {
  test("archive pieces: shared start without the page counter", () => {
    const names = [1, 2, 3, 4, 5].map((i) => `NL-UtHUA_A66354_00000${i}.jpg`);
    expect(mergedName(names)).toBe("NL-UtHUA_A66354 (5 bestanden)");
  });
  test("the upload hash prefix is ignored", () => {
    expect(mergedName(["c6f4674ee8afda72-rapport.pdf"])).toBe("rapport.pdf");
  });
  test("nothing in common: the first name", () => {
    expect(mergedName(["bestek.pdf", "tekening.pdf"])).toBe("bestek (2 bestanden)");
  });
});
