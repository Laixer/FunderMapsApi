import { pgSchema, text, integer, boolean } from "drizzle-orm/pg-core";

export const maplayerSchema = pgSchema("maplayer");

// Tileset bundle metadata. Driven by the worker's tile-generation
// pipeline; the API does not write to this table today, but it is
// queried by the management UI for tileset status.
export const bundle = maplayerSchema.table("bundle", {
  tileset: text().primaryKey(),
  enabled: boolean().default(true).notNull(),
  name: text().notNull(),
  zoomMinLevel: integer("zoom_min_level").notNull(),
  zoomMaxLevel: integer("zoom_max_level").notNull(),
  generateTileset: boolean("generate_tileset").default(true),
  uploadDataset: boolean("upload_dataset"),
});

// Other views in the maplayer schema not modeled here:
//   analysis_building, analysis_foundation, analysis_full,
//     analysis_monitoring, analysis_report, analysis_risk
//   boundry_district, boundry_municipality, boundry_neighborhood
//   building_cluster, building_supercluster
//   facade_scan
//   incident, incident_district, incident_municipality, incident_neighborhood
//   statistics_foundation_risk
// All are tile-source views consumed by the worker's tile-generation
// pipeline and Mapbox vector tile rendering. Not queried via Drizzle;
// add a table declaration here if the API ever needs typed reads.
