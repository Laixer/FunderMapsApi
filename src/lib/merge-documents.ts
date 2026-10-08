import { PDFDocument } from "pdf-lib";

/**
 * Several documents of one melding as one rapportage file.
 *
 * Archive pieces arrive as one scan per page (NL-UtHUA_A66354_000001.jpg …
 * _000005.jpg) and belong together as one archiefonderzoek (Don,
 * 2026-10-08). report.inquiry holds one document_file, so the commit merges
 * them into one PDF, in the order given: PDF pages are copied as they are,
 * JPEG and PNG become a page each, fitted on A4 in the orientation of the
 * image. Anything else (TIFF, WebP, text) is refused by name, so the reviewer
 * can keep that file in a rapportage of its own.
 */

export interface MergePart {
  name: string;
  mimeType: string | null;
  bytes: Uint8Array;
}

export class UnmergeableDocumentError extends Error {
  constructor(public readonly fileName: string, public readonly mimeType: string | null) {
    super(`${fileName}: ${mimeType ?? "onbekend type"} kan niet worden samengevoegd`);
  }
}

const A4: [number, number] = [595.28, 841.89];

/** The mime type, from the stored type or else the file extension. */
export function mergeMime(part: Pick<MergePart, "name" | "mimeType">): string | null {
  if (part.mimeType) return part.mimeType.toLowerCase();
  const ext = part.name.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  return null;
}

export const MERGEABLE_MIMES = new Set(["application/pdf", "image/jpeg", "image/png"]);

export async function mergeToPdf(parts: MergePart[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const part of parts) {
    const mime = mergeMime(part);
    if (mime === "application/pdf") {
      const src = await PDFDocument.load(part.bytes, { ignoreEncryption: true });
      for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
    } else if (mime === "image/jpeg" || mime === "image/png") {
      const image = mime === "image/png" ? await out.embedPng(part.bytes) : await out.embedJpg(part.bytes);
      const [w, h] = image.width > image.height ? [A4[1], A4[0]] : A4;
      const scale = Math.min(w / image.width, h / image.height);
      const page = out.addPage([w, h]);
      page.drawImage(image, {
        x: (w - image.width * scale) / 2,
        y: (h - image.height * scale) / 2,
        width: image.width * scale,
        height: image.height * scale,
      });
    } else {
      throw new UnmergeableDocumentError(part.name, mime);
    }
  }
  return out.save();
}

/**
 * The name of a merged rapportage: the shared start of the file names without
 * the page counter, and how many files went in. "NL-UtHUA_A66354_000001.jpg" …
 * "_000005.jpg" becomes "NL-UtHUA_A66354 (5 bestanden)". Names with nothing
 * meaningful in common fall back to the first name.
 */
export function mergedName(names: string[]): string {
  const bare = names.map((n) => n.replace(/^[0-9a-f]{16}-/, ""));
  if (bare.length === 1) return bare[0]!;
  let prefix = bare[0]!;
  for (const n of bare.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const base = prefix.replace(/[_\-\s.]+\d*$/, "").trim();
  const head = base.length >= 4 ? base : bare[0]!.replace(/\.[a-z0-9]+$/i, "");
  return `${head} (${bare.length} bestanden)`;
}
