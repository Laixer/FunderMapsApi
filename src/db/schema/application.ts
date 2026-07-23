import {
  pgSchema,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  bigint,
  bigserial,
  serial,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const applicationSchema = pgSchema("application");

// Enums
export const jobStatusEnum = applicationSchema.enum("job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "retry",
]);

// Tables
export const user = applicationSchema.table("user", {
  id: uuid().primaryKey().defaultRandom(),
  name: text(),
  givenName: text("given_name"),
  lastName: text("last_name"),
  email: text().notNull(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  avatar: text(),
  jobTitle: text("job_title"),
  phoneNumber: text("phone_number"),
  role: text().default("user").notNull(),
  banned: boolean(),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const session = applicationSchema.table("session", {
  id: text().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text().notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  impersonatedBy: uuid("impersonated_by").references(() => user.id, {
    onDelete: "set null",
  }),
  // Better Auth organization plugin: the session's active organization.
  activeOrganizationId: uuid("active_organization_id").references(
    () => organization.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const account = applicationSchema.table("account", {
  id: text().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text(),
  idToken: text("id_token"),
  password: text(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const verification = applicationSchema.table("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// JWKS — signing keypairs for the Better Auth `jwt` plugin. Used to sign
// ID tokens issued by the OIDC provider plugin (Grafana SSO, etc.).
export const jwks = applicationSchema.table("jwks", {
  id: text().primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
});

// OAuth 2.1 / OIDC client registrations (e.g. Grafana). Read+written by
// the `@better-auth/oauth-provider` plugin (the bundled `oidc-provider`
// was replaced 2026-05-18). DB table stays `oauth_application` for
// backup/tooling continuity; JS export is `oauthClient` to match the
// plugin's model name (BA's drizzleAdapter resolves by JS identifier).
export const oauthClient = applicationSchema.table("oauth_application", {
  id: text().primaryKey(),
  name: text().notNull(),
  icon: text(),
  metadata: jsonb().$type<Record<string, unknown>>(),
  clientId: text("client_id").notNull().unique(),
  // SHA-256 → base64url-no-padding hash (the plugin's `defaultHasher`);
  // verified at request time against the plaintext sent by the client.
  clientSecret: text("client_secret"),
  type: text(),
  public: boolean(),
  disabled: boolean().default(false),
  // Bypass the consent screen for first-party SSO consumers. Read directly
  // from DB by the new plugin (the bundled plugin couldn't).
  skipConsent: boolean("skip_consent").default(false).notNull(),
  // Skip PKCE for this client. Set true for legacy SSO clients (Grafana's
  // generic_oauth doesn't send code_verifier); leave NULL or false for
  // anything new — OAuth 2.1 wants PKCE.
  requirePKCE: boolean("require_pkce"),
  enableEndSession: boolean("enable_end_session"),
  subjectType: text("subject_type"),
  scopes: text().array(),
  grantTypes: text("grant_types").array(),
  responseTypes: text("response_types").array(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  redirectUris: text("redirect_uris").array().notNull(),
  postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
  contacts: text().array(),
  uri: text(),
  tos: text(),
  policy: text(),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  softwareStatement: text("software_statement"),
  referenceId: text("reference_id"),
  userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const oauthAccessToken = applicationSchema.table("oauth_access_token", {
  id: text().primaryKey(),
  token: text().notNull().unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, {
    onDelete: "set null",
  }),
  userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  refreshId: text("refresh_id"),
  scopes: text().array().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const oauthRefreshToken = applicationSchema.table(
  "oauth_refresh_token",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    scopes: text().array().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revoked: timestamp(),
    authTime: timestamp("auth_time"),
  },
);

export const oauthConsent = applicationSchema.table("oauth_consent", {
  id: text().primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  scopes: text().array().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const organization = applicationSchema.table("organization", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  metadata: jsonb().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const organizationUser = applicationSchema.table(
  "organization_user",
  {
    // Scalar id for the Better Auth adapter (`member` model maps onto this
    // table); the composite PK below stays the real identity.
    id: uuid().defaultRandom().notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    role: text().default("reader").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.organizationId] })],
);

// Better Auth organization-plugin invitations (Phase 2).
export const invitation = applicationSchema.table("invitation", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text().notNull(),
  role: text().default("reader").notNull(),
  status: text().default("pending").notNull(),
  teamId: uuid("team_id"),
  inviterId: uuid("inviter_id")
    .notNull()
    .references(() => user.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Better Auth dynamic access control (#1006): admin-defined per-organization
// roles with a JSON permission map (resource -> actions). The table is named
// organization_custom_role because application.organization_role is the role
// enum type; the export keeps BA's model name so the adapter resolves it.
export const organizationRole = applicationSchema.table(
  "organization_custom_role",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    role: text().notNull(),
    permission: jsonb().$type<Record<string, string[]>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
);

export const application = applicationSchema.table("application", {
  applicationId: text("application_id")
    .primaryKey()
    .default(sql`concat('app-', application.random_string(8))`),
  name: text().notNull(),
  data: jsonb().$type<Record<string, unknown>>(),
  secret: text()
    .notNull()
    .default(sql`concat('app-sk-', application.random_string(32))`),
  redirectUrl: text("redirect_url"),
  public: boolean().default(false).notNull(),
  userId: uuid("user_id").references(() => user.id),
});

export const applicationUser = applicationSchema.table(
  "application_user",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    applicationId: text("application_id").notNull(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    updateDate: timestamp("update_date", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.applicationId] }),
  ],
);

export const authKey = applicationSchema.table("auth_key", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id),
  name: text(),
  lastUsed: timestamp("last_used", { withTimezone: true }),
  keyHash: text("key_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Better Auth `@better-auth/api-key` plugin. New `fmsk.`-prefixed keys
// flow through this table; the legacy `application.auth_key` table stays
// the read source for keys created before the plugin landed. The two
// tables coexist until the C# Webservice retires (Dec 2026) and customers
// rotate to BA-issued keys; see project_better_auth_migration.md.
export const apikey = applicationSchema.table("apikey", {
  id: text().primaryKey(),
  configId: text("config_id").default("default").notNull(),
  name: text(),
  start: text(),
  referenceId: uuid("reference_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  prefix: text(),
  key: text().notNull(),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
  enabled: boolean().default(true),
  rateLimitEnabled: boolean("rate_limit_enabled").default(true),
  rateLimitTimeWindow: integer("rate_limit_time_window"),
  rateLimitMax: integer("rate_limit_max"),
  requestCount: integer("request_count").default(0),
  remaining: integer(),
  lastRequest: timestamp("last_request", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  permissions: text(),
  metadata: text(),
});

// Per-(API key, product) billing-event rate limits enforced by the TS
// FunderMapsWebservice (issue #8). One row caps the billable events (rows
// in application.product_tracker, post 24h-dedup) a given key may produce
// for a product within a calendar window. Absent row = unlimited.
//
// `source` discriminates the two key tables: 'ba' → application.apikey.id,
// 'legacy' → application.auth_key.id (uuid as text). The Webservice reads
// this table by (api_key_id, source, product); the API owns writes via the
// management route. NB: the overage *count* is measured per tenant (org),
// not per key — see FunderMapsWebservice#16. Migration:
// FunderMapsWorker/sql/migrate/create_api_key_rate_limit.sql.
export const apiKeyRateLimit = applicationSchema.table(
  "api_key_rate_limit",
  {
    apiKeyId: text("api_key_id").notNull(),
    source: text().notNull(),
    product: text().notNull(),
    period: text().notNull(),
    limitCount: integer("limit_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.apiKeyId, table.source, table.product] }),
  ],
);

export const attribution = applicationSchema.table("attribution", {
  id: serial().primaryKey(),
  reviewer: uuid("reviewer_id").notNull(),
  creator: uuid("creator_id").notNull(),
  owner: uuid("owner_id").notNull(),
  contractor: integer("contractor_id").notNull(),
});

export const contractor = applicationSchema.table("contractor", {
  id: serial().primaryKey(),
  name: text(),
});

// Underlying mapset table — source of truth for layer IDs.
// mapsetCollection (below) is a VIEW that joins this with mapset_layer.
export const mapset = applicationSchema.table("mapset", {
  id: text().primaryKey(),
  name: text(),
  style: text().notNull(),
  layers: text().array(),
  public: boolean().default(false).notNull(),
  consent: text(),
  note: text(),
  icon: text(),
  metadata: jsonb().$type<Record<string, unknown>>(),
  order: integer().default(0).notNull(),
});

export const mapsetLayer = applicationSchema.table("mapset_layer", {
  id: text().primaryKey(),
  name: text().notNull(),
  fields: jsonb().notNull(),
  order: integer().default(0).notNull(),
});

// VIEW. `name` and `slug` follow mapset.name (nullable in DB), so they
// are nullable here too — slug is computed as
// lower(regexp_replace(name, '\s+', '-', 'g')).
export const mapsetCollection = applicationSchema.table("mapset_collection", {
  id: text().primaryKey(),
  name: text(),
  slug: text(),
  style: text().notNull(),
  metadata: jsonb().$type<Record<string, unknown>>(),
  public: boolean().default(false),
  consent: text(),
  note: text(),
  icon: text(),
  order: integer(),
  layerset: jsonb().$type<unknown[]>(),
});

export const fileResource = applicationSchema.table("file_resources", {
  id: uuid().primaryKey().defaultRandom(),
  key: text().notNull().unique(),
  originalFilename: text("original_filename").notNull(),
  status: text().default("uploaded").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  mimeType: text("mime_type"),
  metadata: jsonb().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const productTracker = applicationSchema.table("product_tracker", {
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organization.id),
  product: text().notNull(),
  buildingId: text("building_id").notNull(),
  createDate: timestamp("create_date", { withTimezone: true })
    .defaultNow()
    .notNull(),
  identifier: text().notNull(),
});

export const workerJob = applicationSchema.table("worker_jobs", {
  id: bigserial({ mode: "number" }).primaryKey(),
  jobType: text("job_type").notNull(),
  payload: jsonb().$type<Record<string, unknown>>(),
  status: jobStatusEnum().default("pending").notNull(),
  priority: integer().default(0).notNull(),
  retryCount: integer("retry_count").default(0).notNull(),
  maxRetries: integer("max_retries").default(3).notNull(),
  lastError: text("last_error"),
  processAfter: timestamp("process_after", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Geolock junction tables
export const organizationGeolockDistrict = applicationSchema.table(
  "organization_geolock_district",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    districtId: text("district_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.districtId] }),
  ],
);

export const organizationGeolockMunicipality = applicationSchema.table(
  "organization_geolock_municipality",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    municipalityId: text("municipality_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.municipalityId] }),
  ],
);

export const organizationGeolockNeighborhood = applicationSchema.table(
  "organization_geolock_neighborhood",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    neighborhoodId: text("neighborhood_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.neighborhoodId] }),
  ],
);

// Lives in the application schema (was renamed/moved from maplayer
// during the 2026-04 constraint sweep). Junction table between
// organization and mapset.
export const organizationMapset = applicationSchema.table(
  "organization_mapset",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    mapsetId: text("mapset_id")
      .notNull()
      .references(() => mapset.id),
    metadata: jsonb().$type<Record<string, unknown>>(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.mapsetId] }),
  ],
);

// product_tracker_mismatch — TimescaleDB hypertable, populated by a
// trigger when product_tracker rows mismatch organization geolock.
export const productTrackerMismatch = applicationSchema.table(
  "product_tracker_mismatch",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    identifier: text().notNull(),
    createDate: timestamp("create_date", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

// Generic key/value store — legacy.
export const keyStore = applicationSchema.table("key_store", {
  name: text().primaryKey(),
  value: text().notNull(),
});

// Other views in the application schema not modeled here:
//   file_resources_orphaned (VIEW) — maintenance/cleanup view over
//     file_resources rows whose key has no S3 object behind it.
//     Not queried via Drizzle; add a table declaration if needed.
