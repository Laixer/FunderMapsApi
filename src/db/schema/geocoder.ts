import { pgSchema, text, boolean, date } from "drizzle-orm/pg-core";

export const geocoderSchema = pgSchema("geocoder");

export const address = geocoderSchema.table("address", {
  id: text().primaryKey(),
  externalId: text("external_id").notNull(),
  buildingId: text("building_id"),
  buildingNumber: text("building_number").notNull(),
  postalCode: text("postal_code"),
  street: text().notNull(),
  city: text().notNull(),
});

// Geographic hierarchy. Only id, external_id, and name modelled here;
// the actual rows have more (geom, water, FK refs) but management UIs
// only need name resolution. Note: junction tables (organization_geolock_*)
// store BAG codes which match the *external_id* column, not the
// gfm-* UUID id.
export const district = geocoderSchema.table("district", {
  id: text().primaryKey(),
  externalId: text("external_id").notNull(),
  name: text().notNull(),
});

export const municipality = geocoderSchema.table("municipality", {
  id: text().primaryKey(),
  externalId: text("external_id").notNull(),
  name: text().notNull(),
});

export const neighborhood = geocoderSchema.table("neighborhood", {
  id: text().primaryKey(),
  externalId: text("external_id").notNull(),
  name: text().notNull(),
});

// New snake_case-native declarations (do not use building_active — slated for removal).
// Apply WHERE building.active = true AND building.geom IS NOT NULL inline at call sites
// when active-only filtering is needed.
export const building = geocoderSchema.table("building", {
  id: text().primaryKey(),
  external_id: text().notNull(),
  built_year: date(),
  active: boolean().notNull(),
  building_type: text(),
  neighborhood_id: text(),
});

export const residence = geocoderSchema.table("residence", {
  id: text().primaryKey(),
  address_id: text().notNull(),
  building_id: text().notNull(),
});

export const state = geocoderSchema.table("state", {
  id: text().primaryKey(),
  external_id: text().notNull(),
  country_id: text().notNull(),
  name: text().notNull(),
  water: boolean().notNull(),
});
