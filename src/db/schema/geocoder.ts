import {
  pgSchema,
  text,
  boolean,
  date,
  varchar,
  doublePrecision,
} from "drizzle-orm/pg-core";

export const geocoderSchema = pgSchema("geocoder");

// PostGIS geometry columns are modeled as text() — Drizzle has no
// first-class geometry type. Reads return WKB hex from postgres.js
// unless the query wraps with ST_AsText/ST_AsGeoJSON. Treat the field
// as opaque from Drizzle's perspective.

export const country = geocoderSchema.table("country", {
  id: text().primaryKey(),
  externalId: text("external_id").notNull(),
  name: text().notNull(),
  geom: text().notNull(),
});

export const state = geocoderSchema.table("state", {
  id: text().primaryKey(),
  externalId: text("external_id").notNull(),
  countryId: text("country_id")
    .notNull()
    .references(() => country.id),
  name: text().notNull(),
  water: boolean().notNull(),
  geom: text().notNull(),
});

export const municipality = geocoderSchema.table("municipality", {
  id: text().primaryKey(),
  externalId: text("external_id").notNull(),
  name: text().notNull(),
  water: boolean().notNull(),
  geom: text().notNull(),
  stateId: text("state_id")
    .notNull()
    .references(() => state.id),
});

export const district = geocoderSchema.table("district", {
  id: text().primaryKey(),
  externalId: text("external_id").notNull(),
  municipalityId: text("municipality_id")
    .notNull()
    .references(() => municipality.id),
  name: text().notNull(),
  water: boolean().notNull(),
  geom: text().notNull(),
});

export const neighborhood = geocoderSchema.table("neighborhood", {
  id: text().primaryKey(),
  externalId: text("external_id").notNull(),
  districtId: text("district_id")
    .notNull()
    .references(() => district.id),
  name: text().notNull(),
  water: boolean().notNull(),
  geom: text().notNull(),
});

// snake_case-native declaration (do not use building_active — slated
// for removal). Apply WHERE building.active = true AND
// building.geom IS NOT NULL inline at call sites when active-only
// filtering is needed.
//
// zone_function is a geocoder.zone_function[] enum array;
// declared as text().array() per the codebase convention for enums.
export const building = geocoderSchema.table("building", {
  id: text().primaryKey(),
  external_id: text().notNull(),
  built_year: date(),
  active: boolean().notNull(),
  geom: text().notNull(),
  building_type: text(),
  neighborhood_id: text().references(() => neighborhood.id),
  zone_function: text().array(),
});

export const address = geocoderSchema.table("address", {
  id: text().primaryKey(),
  externalId: text("external_id").notNull(),
  buildingId: text("building_id").references(() => building.id),
  buildingNumber: text("building_number").notNull(),
  postalCode: text("postal_code"),
  street: text().notNull(),
  city: text().notNull(),
});

export const residence = geocoderSchema.table("residence", {
  id: text().primaryKey(),
  address_id: text()
    .notNull()
    .references(() => address.id),
  building_id: text()
    .notNull()
    .references(() => building.id),
  geom: text().notNull(),
});

// 6-character postal code as the natural key (e.g. "1011AB").
export const postalCode = geocoderSchema.table("postal_code", {
  postalCode: varchar("postal_code", { length: 6 }).primaryKey(),
  geom: text().notNull(),
});

// VIEW. Joined hydrate of building + residence + geo hierarchy.
// Currently queried via raw SQL in services/geocoder.ts; this
// declaration enables typed Drizzle reads as a follow-up.
export const buildingGeocoder = geocoderSchema.table("building_geocoder", {
  buildingBuiltYear: date("building_built_year"),
  buildingId: text("building_id"),
  buildingType: text("building_type"),
  buildingZoneFunction: text("building_zone_function").array(),
  residenceId: text("residence_id"),
  residenceLat: doublePrecision("residence_lat"),
  residenceLon: doublePrecision("residence_lon"),
  neighborhoodId: text("neighborhood_id"),
  neighborhoodName: text("neighborhood_name"),
  districtId: text("district_id"),
  districtName: text("district_name"),
  municipalityId: text("municipality_id"),
  municipalityName: text("municipality_name"),
  stateId: text("state_id"),
  stateName: text("state_name"),
});

// Other views in the geocoder schema not modeled here:
//   address_building (VIEW) — joins address + building
//   building_active (VIEW) — slated for removal
// Not queried via Drizzle today.
