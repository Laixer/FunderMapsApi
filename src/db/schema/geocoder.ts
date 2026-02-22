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
