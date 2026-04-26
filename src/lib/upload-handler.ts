import type { Context } from "hono";
import {
  ALLOWED_UPLOAD_MIMES,
  MAX_UPLOAD_BYTES,
  putObject,
  uniqueFileName,
} from "./s3.ts";
import { ValidationError, ForbiddenError } from "./errors.ts";
import type { AppEnv } from "../types/context.ts";

// Roles allowed to upload report documents — mirrors C# WriterAdministratorPolicy
// (writer, verifier, superuser). Excludes "reader".
const WRITE_ROLES = new Set(["writer", "verifier", "superuser"]);

import { db } from "../db/client.ts";
import { eq, and } from "drizzle-orm";
import { organizationUser } from "../db/schema/application.ts";

async function assertCanWrite(
  userId: string,
  orgId: string | undefined,
): Promise<void> {
  if (!orgId) {
    throw new ForbiddenError("User is not a member of any organization");
  }
  const [row] = await db
    .select({ role: organizationUser.role })
    .from(organizationUser)
    .where(
      and(
        eq(organizationUser.userId, userId),
        eq(organizationUser.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row || !row.role || !WRITE_ROLES.has(row.role)) {
    throw new ForbiddenError("Write permission required");
  }
}

// Mirrors C# `[FormFile(AllowedFileMimes)] IFormFile input` + StoreFileAsync.
// Returns the storage key (folder + unique name) and the unique filename,
// matching the `{ name }` shape ClientApp expects from upload-document.
export async function handleDocumentUpload(
  c: Context<AppEnv>,
  folder: "inquiry-report" | "recovery-report",
): Promise<{ name: string }> {
  const u = c.get("user");
  await assertCanWrite(u.id, u.organizations[0]?.id);

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

  return { name: filename };
}
