import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  fromIdentifier,
  GeocoderDatasource,
} from "../lib/geocoder-id.ts";
import {
  getBuildingByGeocoderId,
  resolveToBuildingId,
} from "../services/geocoder.ts";
import { NotFoundError, AppError } from "../lib/errors.ts";

const geocoder = new Hono();

// Composite building-info: address + geographic hierarchy in one round-trip.
// Returns flat snake_case; consumer (WebFront) reconstructs any nested view it
// needs. address picked with LIMIT 1 — N:1 ambiguity is acknowledged
// (see project_address_building_n_to_1.md).
geocoder.get("/building-info/:id", async (c) => {
  const input = c.req.param("id");
  const buildingId = await resolveToBuildingId(input);

  const rows = await db.execute(sql`
    SELECT
      b.external_id AS building_id,
      a.id AS address_id,
      a.external_id AS address_external_id,
      a.street,
      a.building_number,
      a.postal_code,
      a.city,
      n.id AS neighborhood_id,
      n.external_id AS neighborhood_external_id,
      n.name AS neighborhood_name,
      d.id AS district_id,
      d.external_id AS district_external_id,
      d.name AS district_name,
      m.id AS municipality_id,
      m.external_id AS municipality_external_id,
      m.name AS municipality_name,
      s.id AS state_id,
      s.external_id AS state_external_id,
      s.name AS state_name
    FROM geocoder.building b
    LEFT JOIN geocoder.address a ON a.building_id = b.external_id
    LEFT JOIN geocoder.neighborhood n ON n.id = b.neighborhood_id
    LEFT JOIN geocoder.district d ON d.id = n.district_id
    LEFT JOIN geocoder.municipality m ON m.id = d.municipality_id
    LEFT JOIN geocoder.state s ON s.id = m.state_id
    WHERE b.external_id = ${buildingId}
      AND b.active = true
      AND b.geom IS NOT NULL
    ORDER BY a.id
    LIMIT 1
  `);

  if (rows.length === 0) throw new NotFoundError("Building not found");

  c.header("Cache-Control", "public, max-age=3600");
  return c.json(rows[0]);
});

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
