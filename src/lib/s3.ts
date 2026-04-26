import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config.ts";

let _client: S3Client | null = null;

function client(): S3Client {
  if (_client) return _client;
  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY || !env.S3_BUCKET) {
    throw new Error(
      "S3 storage not configured: set S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET",
    );
  }
  _client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });
  return _client;
}

// Mirrors FunderMaps.Core.Constants.AllowedFileMimes — keep in sync if the
// C# whitelist changes (currently identical across both stacks).
export const ALLOWED_UPLOAD_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/webp",
  "text/plain",
]);

export const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
  "text/plain": ".txt",
};

// Mirrors FunderMaps.Core.Helpers.FileHelper.GetUniqueName: GUID + original
// extension. Keep stable so files written by either stack are readable from
// the other.
export function uniqueFileName(originalName: string | undefined, contentType: string): string {
  const ext = (() => {
    if (originalName) {
      const dot = originalName.lastIndexOf(".");
      if (dot > 0 && dot < originalName.length - 1) {
        return originalName.slice(dot).toLowerCase();
      }
    }
    return EXT_BY_MIME[contentType] ?? "";
  })();
  return `${crypto.randomUUID()}${ext}`;
}

export async function putObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET!,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}
