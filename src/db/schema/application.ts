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
  accessFailedCount: integer("access_failed_count").default(0).notNull(),
  role: text().default("user").notNull(),
  lastLogin: timestamp("last_login").defaultNow(),
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

// OAuth2 / OIDC client registrations (e.g. Grafana). Issued by the
// Better Auth `oidc-provider` plugin.
export const oauthApplication = applicationSchema.table("oauth_application", {
  id: text().primaryKey(),
  name: text().notNull(),
  icon: text(),
  metadata: text(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  redirectUrls: text("redirect_urls").notNull(),
  type: text().notNull(),
  disabled: boolean().default(false),
  userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const oauthAccessToken = applicationSchema.table("oauth_access_token", {
  id: text().primaryKey(),
  accessToken: text("access_token").notNull().unique(),
  refreshToken: text("refresh_token").notNull().unique(),
  accessTokenExpiresAt: timestamp("access_token_expires_at").notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at").notNull(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
  scopes: text().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const oauthConsent = applicationSchema.table("oauth_consent", {
  id: text().primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  scopes: text().notNull(),
  consentGiven: boolean("consent_given").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const organization = applicationSchema.table("organization", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
});

export const organizationUser = applicationSchema.table(
  "organization_user",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    role: text(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.organizationId] })],
);

export const application = applicationSchema.table("application", {
  applicationId: text("application_id").primaryKey(),
  name: text().notNull(),
  data: jsonb().$type<Record<string, unknown>>(),
  secret: text()
    .notNull()
    .default(sql`concat('app-sk-', application.random_string(32))`),
  redirectUrl: text("redirect_url"),
  public: boolean().default(false),
  userId: uuid("user_id").references(() => user.id),
});

export const applicationUser = applicationSchema.table(
  "application_user",
  {
    userId: text("user_id").notNull(),
    applicationId: text("application_id").notNull(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    updateDate: timestamp("update_date"),
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
  lastUsed: timestamp("last_used"),
  keyHash: text("key_hash").notNull(),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const authLog = applicationSchema.table("auth_logs", {
  logId: bigserial("log_id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id").references(() => user.id),
  actionType: text("action_type").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  timestamp: timestamp().defaultNow(),
  metadata: jsonb().$type<Record<string, unknown>>(),
});

export const attribution = applicationSchema.table("attribution", {
  id: bigserial({ mode: "number" }).primaryKey(),
  reviewer: uuid("reviewer_id").notNull(),
  creator: uuid("creator_id").notNull(),
  owner: uuid("owner_id").notNull(),
  contractor: integer("contractor_id").notNull(),
});

export const contractor = applicationSchema.table("contractor", {
  id: integer().primaryKey(),
  name: text().notNull(),
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

export const mapsetCollection = applicationSchema.table("mapset_collection", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull(),
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
  status: text().default("uploaded"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  mimeType: text("mime_type"),
  metadata: jsonb().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
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
  processAfter: timestamp("process_after"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
      .references(() => mapsetCollection.id),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.mapsetId] }),
  ],
);
