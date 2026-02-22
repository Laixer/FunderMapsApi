import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { address } from "../db/schema/geocoder.ts";
import {
  fromIdentifier,
  GeocoderDatasource,
} from "../lib/geocoder-id.ts";
import { NotFoundError, AppError } from "../lib/errors.ts";

const geocoder = new Hono();

geocoder.get("/:geocoder_id", async (c) => {
  const geocoderId = c.req.param("geocoder_id");
  const datasource = fromIdentifier(geocoderId);

  let externalId: string;

  switch (datasource) {
    case GeocoderDatasource.NlBagBuilding:
      externalId = geocoderId;
      break;
    case GeocoderDatasource.NlBagLegacyBuilding: {
      const normalized = geocoderId.toUpperCase().replaceAll(" ", "");
      externalId = `NL.IMBAG.PAND.${normalized}`;
      break;
    }
    case GeocoderDatasource.NlBagAddress:
    case GeocoderDatasource.NlBagLegacyAddress: {
      // Look up building via address join
      let addressId = geocoderId;
      if (datasource === GeocoderDatasource.NlBagLegacyAddress) {
        const normalized = geocoderId.toUpperCase().replaceAll(" ", "");
        addressId = `NL.IMBAG.NUMMERAANDUIDING.${normalized}`;
      }
      const result = await db.execute(sql`
        SELECT b.external_id
        FROM geocoder.building_geocoder b
        JOIN geocoder.address a ON a.building_id = b.id
        WHERE a.external_id = ${addressId}
        LIMIT 1
      `);
      if (result.length === 0) throw new NotFoundError("Building not found");
      externalId = (result[0] as { external_id: string }).external_id;
      break;
    }
    default:
      throw new AppError(400, "Unknown geocoder identifier");
  }

  const result = await db.execute(sql`
    SELECT * FROM geocoder.building_geocoder
    WHERE external_id = ${externalId}
    LIMIT 1
  `);

  if (result.length === 0) throw new NotFoundError("Building not found");

  c.header("Cache-Control", "public, max-age=3600");
  return c.json(result[0]);
});

geocoder.get("/:geocoder_id/address", async (c) => {
  const geocoderId = c.req.param("geocoder_id");

  const rows = await db.execute(sql`
    SELECT a.external_id AS id, a.building_number, a.postal_code, a.street, a.city
    FROM geocoder.address a
    JOIN geocoder.building b ON b.id = a.building_id
    WHERE b.external_id = ${geocoderId}
  `);

  if (rows.length === 0) throw new NotFoundError("Addresses not found");

  c.header("Cache-Control", "public, max-age=3600");
  return c.json(rows);
});

export default geocoder;
