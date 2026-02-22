import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { env } from "../config.ts";
import { db } from "../db/client.ts";
import { fileResource } from "../db/schema/application.ts";
import { AppError } from "../lib/errors.ts";

const ALLOWED_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "pdf", "doc", "docx",
  "xls", "xlsx", "csv", "txt", "zip", "ppt", "pptx",
]);

function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function isExtensionAllowed(filename: string): boolean {
  return ALLOWED_EXTENSIONS.has(getExtension(filename));
}

function randomKey(length = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (const byte of bytes) {
    result += chars[byte % chars.length];
  }
  return result;
}

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
      throw new AppError(500, "S3 storage not configured");
    }
    s3Client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
      },
      forcePathStyle: true,
    });
  }
  return s3Client;
}

export interface FileUploadResult {
  files: string[];
  key: string;
  totalSize: number;
  totalFiles: number;
}

export async function uploadFiles(
  formData: FormData,
  fieldName = "files",
): Promise<FileUploadResult> {
  const files = formData.getAll(fieldName) as File[];

  if (files.length === 0) {
    throw new AppError(400, "No files provided");
  }

  for (const file of files) {
    if (!isExtensionAllowed(file.name)) {
      throw new AppError(400, `File extension not allowed: ${file.name}`);
    }
  }

  const key = randomKey();
  const client = getS3Client();
  const uploadedFiles: string[] = [];
  let totalSize = 0;

  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const s3Key = `user-data/${key}/${file.name}`;

    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: s3Key,
        Body: new Uint8Array(buffer),
        ContentType: file.type,
      }),
    );

    await db.insert(fileResource).values({
      key,
      originalFilename: file.name,
      status: "uploaded",
      sizeBytes: file.size,
      mimeType: file.type,
    });

    uploadedFiles.push(file.name);
    totalSize += file.size;
  }

  return {
    files: uploadedFiles,
    key,
    totalSize,
    totalFiles: files.length,
  };
}

export async function updateFileStatus(
  key: string,
  status: string,
): Promise<void> {
  await db
    .update(fileResource)
    .set({ status, updatedAt: new Date() })
    .where(eq(fileResource.key, key));
}
