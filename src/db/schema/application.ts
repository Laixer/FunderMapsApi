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

export const applicationSchema = pgSchema("application");

// Enums
export const jobStatusEnum = applicationSchema.enum("job_status", [
  "pending",
  "running",
  "complete",
  "failed",
  "retry",
]);

// Tables
export const user = applicationSchema.table("user", {
  id: uuid().primaryKey().defaultRandom(),
  givenName: text("given_name"),
  lastName: text("last_name"),
  email: text().notNull(),
  avatar: text(),
  jobTitle: text("job_title"),
  passwordHash: text("password_hash").notNull(),
  phoneNumber: text("phone_number"),
  accessFailedCount: integer("access_failed_count").default(0).notNull(),
  role: text().default("user").notNull(),
  lastLogin: timestamp("last_login").defaultNow(),
  loginCount: integer("login_count").default(0).notNull(),
});

export const organization = applicationSchema.table("organization", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  email: text(),
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
  applicationId: text("id").primaryKey(),
  name: text().notNull(),
  data: jsonb().$type<Record<string, unknown>>(),
  secret: text(),
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
  key: text().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id),
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
  reviewer: uuid().notNull(),
  creator: uuid().notNull(),
  owner: uuid().notNull(),
  contractor: integer().notNull(),
});

export const contractor = applicationSchema.table("contractor", {
  id: integer().primaryKey(),
  name: text().notNull(),
});

export const mapsetCollection = applicationSchema.table("mapset_collection", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull(),
  style: text().notNull(),
  layers: text().array(),
  options: jsonb().$type<Record<string, unknown>>(),
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
  name: text().notNull(),
  buildingId: text("building_id").notNull(),
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
