import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  fromIdentifier,
  GeocoderDatasource,
} from "../lib/geocoder-id.ts";
import { getBuildingByGeocoderId } from "../services/geocoder.ts";
import { NotFoundError, AppError } from "../lib/errors.ts";

const geocoder = new Hono();

// Single address by identifier — mirrors C# /api/geocoder/address/{id}.
// Accepts FunderMaps gfm-* IDs (geocoder.address.id, the PK), BAG address IDs
// (NL.IMBAG.NUMMERAANDUIDING.*, geocoder.address.external_id), or BAG building
// IDs (NL.IMBAG.PAND.*, returns one address tied to that building).
geocoder.get("/address/:id", async (c) => {
  const input = c.req.param("id");
  const ds = fromIdentifier(input);

  let where: ReturnType<typeof sql>;
  switch (ds) {
    case GeocoderDatasource.FunderMaps:
      where = sql`a.id = ${input}`;
      break;
    case GeocoderDatasource.NlBagAddress:
      where = sql`a.external_id = ${input.replaceAll(" ", "").toUpperCase()}`;
      break;
    case GeocoderDatasource.NlBagBuilding:
      where = sql`a.building_id = ${input.replaceAll(" ", "").toUpperCase()}`;
      break;
    default:
      throw new AppError(400, "Unsupported address identifier");
  }

  const rows = await db.execute(sql`
    SELECT a.id, a.external_id, a.building_number, a.postal_code, a.street, a.city, a.building_id
    FROM geocoder.address a
    WHERE ${where}
    LIMIT 1
  `);

  if (rows.length === 0) throw new NotFoundError("Address not found");

  c.header("Cache-Control", "public, max-age=3600");
  return c.json(rows[0]);
});

geocoder.get("/:geocoder_id", async (c) => {
  const geocoderId = c.req.param("geocoder_id");

  const building = await getBuildingByGeocoderId(geocoderId);

  c.header("Cache-Control", "public, max-age=3600");
  return c.json(building);
});

export default geocoder;
