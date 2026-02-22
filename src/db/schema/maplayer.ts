import { pgSchema, text, uuid, primaryKey } from "drizzle-orm/pg-core";
import { organization, mapsetCollection } from "./application.ts";

export const maplayerSchema = pgSchema("maplayer");

export const organizationMapset = maplayerSchema.table(
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
