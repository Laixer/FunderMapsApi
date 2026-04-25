import { z } from "zod/v4";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  APP_ID: z.string(),

  // Better Auth
  AUTH_SECRET: z.string(),
  BASE_URL: z.url().optional(),
  // Comma-separated list of frontend origins allowed to talk to /api/auth/*.
  // Required when the frontend is on a different domain than BASE_URL,
  // otherwise Better Auth's CSRF check returns 403 INVALID_ORIGIN.
  TRUSTED_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [],
    ),

  // S3 / DigitalOcean Spaces
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),

  // Mailgun
  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_DOMAIN: z.string().optional(),
  MAILGUN_API_BASE: z.string().default("https://api.eu.mailgun.net/v3"),
  EMAIL_RECEIVERS: z.string().optional(),

  // PDF service
  PDF_SERVICE_URL: z.string().optional(),

  // Proxy
  PROXY_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  PROXY_HEADER: z.string().default("X-Forwarded-For"),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
