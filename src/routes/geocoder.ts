import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { getBuildingByGeocoderId } from "../services/geocoder.ts";
import { NotFoundError } from "../lib/errors.ts";

const geocoder = new Hono();

geocoder.get("/:geocoder_id", async (c) => {
  const geocoderId = c.req.param("geocoder_id");

  const building = await getBuildingByGeocoderId(geocoderId);

  c.header("Cache-Control", "public, max-age=3600");
  return c.json(building);
});

geocoder.get("/:geocoder_id/address", async (c) => {
  const geocoderId = c.req.param("geocoder_id");

  const rows = await db.execute(sql`
    SELECT a.external_id AS id, a.building_number, a.postal_code, a.street, a.city
    FROM geocoder.address a
    WHERE a.building_id = ${geocoderId}
  `);

  if (rows.length === 0) throw new NotFoundError("Addresses not found");

  c.header("Cache-Control", "public, max-age=3600");
  return c.json(rows);
});

export default geocoder;
