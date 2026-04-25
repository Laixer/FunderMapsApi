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

// Geographic hierarchy — only id + name modelled here; the full row
// has more (geom, etc.) but management UIs only need name resolution.
export const district = geocoderSchema.table("district", {
  id: text().primaryKey(),
  name: text(),
});

export const municipality = geocoderSchema.table("municipality", {
  id: text().primaryKey(),
  name: text(),
});

export const neighborhood = geocoderSchema.table("neighborhood", {
  id: text().primaryKey(),
  name: text(),
});
