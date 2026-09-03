import { z } from "zod/v4";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  APP_ID: z.string(),

  // Platform organization ("FunderMaps B.V."). Members are FunderMaps' own
  // invoer staff who enter data on behalf of customer organizations (#973
  // central-account workflow) — inquiry/recovery routes lift the per-org data
  // scoping for them. Their role *within* this org still decides
  // read/write/review level.
  PLATFORM_ORGANIZATION_ID: z
    .uuid()
    .default("d8c19418-c832-4c91-8993-84b8ed641448"),

  // Better Auth
  AUTH_SECRET: z.string(),
  BASE_URL: z.url().optional(),
  // The dedicated auth SPA's login page — where the OIDC provider sends
  // unauthenticated users (`loginPage`). Prod: https://auth.fundermaps.com/login.
  LOGIN_PAGE_URL: z.url().default("https://auth.fundermaps.com/login"),
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

  // Email (Resend). Unset key = emails are logged and skipped. MAIL_FROM must
  // be on a domain verified in Resend; today that is only funderdata.nl.
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("FunderMaps <noreply@funderdata.nl>"),
  // Data Studio base URL, used for deep links in workflow emails.
  STUDIO_URL: z.url().default("https://studio.fundermaps.com"),

  // PDF renderer (Gotenberg, self-hosted; replaces pdf.co).
  // GOTENBERG_URL is the base URL of the Gotenberg HTTP API — for prod that's
  // the in-VPC service URL, for local dev the rootless podman container on the
  // host. REPORT_RENDER_URL is the base URL of the report front-end that
  // Gotenberg renders into a PDF (defaults to the existing whale-app DO
  // instance).
  GOTENBERG_URL: z.url().optional(),
  REPORT_RENDER_URL: z
    .string()
    .default("https://whale-app-nm9uv.ondigitalocean.app"),

  // Public intake (the terugmeldformulier). The shared secret the intake app
  // presents; absent, the whole intake lane answers 503 rather than accepting
  // anonymous writes.
  INTAKE_TOKEN: z.string().optional(),
  // Portal number baked into every meldcode: FIR<client><year>-<seq>. 01 is
  // FunderMaps' own form; 10, 22-26 and 61-70 are the municipal portals that
  // moved off our infrastructure in March 2026.
  INTAKE_CLIENT_ID: z.coerce.number().int().min(0).max(99).default(1),

  // Proxy
  PROXY_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  PROXY_HEADER: z.string().default("X-Forwarded-For"),
});

export const env = envSchema.parse(process.env);
