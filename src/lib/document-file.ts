/**
 * What the stored document actually is.
 *
 * `inquiry.document_file` / `recovery.document_file` hold only the storage
 * filename, and `uniqueFileName()` makes that a bare `crypto.randomUUID()` plus
 * an extension — so the record knows where the file is and nothing about what it
 * is called. That is why the UI could offer no better label than "Document".
 *
 * The real name is in `application.file_resources`, keyed by the full S3 object
 * key, along with the media type and size. Uploads that predate that table
 * (Laixer/FunderMaps#861) have no row, so every field here is nullable and
 * callers fall back to the storage name.
 */

import { eq } from "drizzle-orm";

import { db } from "../db/client.ts";
import { fileResource } from "../db/schema/application.ts";
import { getDownloadUrl } from "./s3.ts";

export interface DocumentFileInfo {
  /** Short-lived signed URL for the object. */
  accessLink: string;
  /** Storage filename — the GUID. Always present; the fallback label. */
  storageName: string;
  /** What the uploader called it, when we know. */
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

/**
 * Media types the upload whitelist accepts that a browser can display inline.
 * `image/tiff` is deliberately absent: it is on the whitelist but no major
 * browser renders it, so previewing it would show a broken image.
 */
const PREVIEWABLE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/webp",
]);

export function isPreviewableImage(mimeType: string | null): boolean {
  return mimeType !== null && PREVIEWABLE_IMAGE_MIMES.has(mimeType);
}

export async function describeDocumentFile(
  folder: "inquiry-report" | "recovery-report",
  documentFile: string,
): Promise<DocumentFileInfo> {
  const key = `${folder}/${documentFile}`;

  // One round trip each, in parallel: the signed URL is computed locally by the
  // presigner and the lookup is a unique-index hit, so neither gates the other.
  const [accessLink, [row]] = await Promise.all([
    getDownloadUrl(key, 1),
    db
      .select({
        originalFilename: fileResource.originalFilename,
        mimeType: fileResource.mimeType,
        sizeBytes: fileResource.sizeBytes,
      })
      .from(fileResource)
      .where(eq(fileResource.key, key))
      .limit(1),
  ]);

  return {
    accessLink,
    storageName: documentFile,
    originalFilename: row?.originalFilename ?? null,
    mimeType: row?.mimeType ?? null,
    sizeBytes: row?.sizeBytes ?? null,
  };
}
