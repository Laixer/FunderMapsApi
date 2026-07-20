import type { Context } from "hono";
import {
  ALLOWED_UPLOAD_MIMES,
  MAX_UPLOAD_BYTES,
  putObject,
  uniqueFileName,
} from "./s3.ts";
import { eq } from "drizzle-orm";
import { ValidationError } from "./errors.ts";
import { assertOrgPermission } from "./auth-helpers.ts";
import type { AppEnv } from "../types/context.ts";
import { db } from "../db/client.ts";
import { fileResource } from "../db/schema/application.ts";

// Mirrors C# `[FormFile(AllowedFileMimes)] IFormFile input` + StoreFileAsync.
// Returns the storage key (folder + unique name) and the unique filename,
// matching the `{ name }` shape ClientApp expects from upload-document.
export async function handleDocumentUpload(
  c: Context<AppEnv>,
  folder: "inquiry-report" | "recovery-report",
): Promise<{ name: string }> {
  const u = c.get("user");
  await assertOrgPermission(
    u.id,
    u.organizations[0]?.id,
    folder === "inquiry-report" ? "inquiry" : "recovery",
    "write",
  );

  const form = await c.req.parseBody();
  const file = form["input"];
  if (!file || typeof file === "string" || !(file instanceof File)) {
    throw new ValidationError(["Missing 'input' file in multipart body"]);
  }
  if (file.size === 0) {
    throw new ValidationError(["Empty file"]);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ValidationError([
      `File too large: ${file.size} bytes (max ${MAX_UPLOAD_BYTES})`,
    ]);
  }

  // file.type may include parameters (e.g. "text/plain;charset=utf-8"); strip
  // them before checking the whitelist so the stored object still records a
  // clean media type and validation matches by media type alone.
  const fullContentType = file.type || "application/octet-stream";
  const baseContentType = fullContentType.split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_UPLOAD_MIMES.has(baseContentType)) {
    throw new ValidationError([`Unsupported content type: ${fullContentType}`]);
  }

  const filename = uniqueFileName(file.name, baseContentType);
  const key = `${folder}/${filename}`;
  const body = new Uint8Array(await file.arrayBuffer());
  await putObject(key, body, baseContentType);

  // Register the upload in the resource table (Laixer/FunderMaps#861) so user
  // uploads are tracked in the database. `key` is the full S3 object key
  // (folder + unique name): unique, and enough to locate the stored object,
  // which the application.file_resources_orphaned sweep relies on. Status stays
  // 'uploaded' until the file is attached to an inquiry/recovery record.
  await db.insert(fileResource).values({
    key,
    originalFilename: file.name,
    status: "uploaded",
    sizeBytes: file.size,
    mimeType: baseContentType,
  });

  return { name: filename };
}

// Attach-time lifecycle transition: a record referencing the upload moves it
// 'uploaded' → 'active' (out of the file_resources_orphaned sweep); replacing
// or deleting the record moves the old object to 'archived'. `key` is the
// full S3 object key. Uploads that predate the resource table produce no row
// here, so a miss is a silent no-op by design.
export async function markFileResource(
  key: string,
  status: "active" | "archived",
): Promise<void> {
  await db
    .update(fileResource)
    .set({ status, updatedAt: new Date() })
    .where(eq(fileResource.key, key));
}
