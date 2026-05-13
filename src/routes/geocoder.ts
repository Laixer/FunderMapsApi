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
      public.ST_Y(r.geom) AS residence_lat,
      public.ST_X(r.geom) AS residence_lon,
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
    LEFT JOIN geocoder.residence r ON r.building_id = b.external_id
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

// Residence by identifier. Accepts FunderMaps internal gfm-* (residence.id),
// BAG PAND IDs (resolved to residence via building_id), or BAG legacy
// building IDs. C# parity: /api/geocoder/residence/{id} — the C# call site
// in GeocoderController.GetAsync feeds it the building external_id, so the
// PAND-path is the common case.
geocoder.get("/residence/:id", async (c) => {
  const input = c.req.param("id");
  const ds = fromIdentifier(input);

  let where: ReturnType<typeof sql>;
  switch (ds) {
    case GeocoderDatasource.FunderMaps:
      where = sql`r.id = ${input}`;
      break;
    case GeocoderDatasource.NlBagBuilding:
      where = sql`r.building_id = ${input.replaceAll(" ", "").toUpperCase()}`;
      break;
    case GeocoderDatasource.NlBagLegacyBuilding:
      where = sql`r.building_id = ${"NL.IMBAG.PAND." + input.replaceAll(" ", "").toUpperCase()}`;
      break;
    default:
      throw new AppError(400, "Unsupported residence identifier");
  }

  const rows = await db.execute(sql`
    SELECT r.id, r.address_id, r.building_id
    FROM geocoder.residence r
    WHERE ${where}
    LIMIT 1
  `);

  if (rows.length === 0) throw new NotFoundError("Residence not found");

  c.header("Cache-Control", "public, max-age=3600");
  return c.json(rows[0]);
});

// Generic single-row lookup for the geographic-hierarchy entities. Accepts
// gfm-* (matches PK) or the CBS code (matches external_id). The caller passes
// the entity-specific datasource enum value used for CBS classification.
async function lookupHierarchy(
  table: "neighborhood" | "district" | "municipality" | "state",
  input: string,
  cbsDatasource: GeocoderDatasource,
): Promise<Record<string, unknown>> {
  const ds = fromIdentifier(input);

  let where: ReturnType<typeof sql>;
  if (ds === GeocoderDatasource.FunderMaps) {
    where = sql`id = ${input}`;
  } else if (ds === cbsDatasource) {
    where = sql`external_id = ${input.toUpperCase()}`;
  } else {
    throw new AppError(400, `Unsupported ${table} identifier`);
  }

  // Common shape across all four tables: id, external_id, name, water,
  // plus parent FK. Geom is omitted — clients that need polygons read
  // the tile service.
  const cols =
    table === "state"
      ? sql`id, external_id, name, water, country_id`
      : table === "municipality"
        ? sql`id, external_id, name, water, state_id`
        : table === "district"
          ? sql`id, external_id, name, water, municipality_id`
          : sql`id, external_id, name, water, district_id`;

  const rows = await db.execute(sql`
    SELECT ${cols}
    FROM ${sql.identifier("geocoder")}.${sql.identifier(table)}
    WHERE ${where}
    LIMIT 1
  `);

  if (rows.length === 0) throw new NotFoundError(`${table} not found`);
  return rows[0] as Record<string, unknown>;
}

geocoder.get("/neighborhood/:id", async (c) => {
  const row = await lookupHierarchy(
    "neighborhood",
    c.req.param("id"),
    GeocoderDatasource.NlCbsNeighborhood,
  );
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(row);
});

geocoder.get("/district/:id", async (c) => {
  const row = await lookupHierarchy(
    "district",
    c.req.param("id"),
    GeocoderDatasource.NlCbsDistrict,
  );
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(row);
});

geocoder.get("/municipality/:id", async (c) => {
  const row = await lookupHierarchy(
    "municipality",
    c.req.param("id"),
    GeocoderDatasource.NlCbsMunicipality,
  );
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(row);
});

geocoder.get("/state/:id", async (c) => {
  const row = await lookupHierarchy(
    "state",
    c.req.param("id"),
    GeocoderDatasource.NlCbsState,
  );
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(row);
});

geocoder.get("/:geocoder_id", async (c) => {
  const geocoderId = c.req.param("geocoder_id");

  const building = await getBuildingByGeocoderId(geocoderId);

  c.header("Cache-Control", "public, max-age=3600");
  return c.json(building);
});

export default geocoder;
