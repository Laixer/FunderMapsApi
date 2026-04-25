import { pgSchema, text } from "drizzle-orm/pg-core";

export const geocoderSchema = pgSchema("geocoder");

export const address = geocoderSchema.table("address", {
  id: text().primaryKey(),
  externalId: text("external_id"),
  buildingId: text("building_id"),
  buildingNumber: text("building_number"),
  postalCode: text("postal_code"),
  street: text(),
  city: text(),
});

// Geographic hierarchy. Only id, external_id, and name modelled here;
// the actual rows have more (geom, etc.) but management UIs only need
// name resolution. Note: junction tables (organization_geolock_*)
// store BAG codes which match the *external_id* column, not the
// gfm-* UUID id.
export const district = geocoderSchema.table("district", {
  id: text().primaryKey(),
  externalId: text("external_id"),
  name: text(),
});

export const municipality = geocoderSchema.table("municipality", {
  id: text().primaryKey(),
  externalId: text("external_id"),
  name: text(),
});

export const neighborhood = geocoderSchema.table("neighborhood", {
  id: text().primaryKey(),
  externalId: text("external_id"),
  name: text(),
});
