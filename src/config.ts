import { z } from "zod/v4";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  APP_ID: z.string(),

  // Better Auth
  AUTH_SECRET: z.string(),
  BASE_URL: z.url().optional(),

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
