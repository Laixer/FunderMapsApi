import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  fromIdentifier,
  GeocoderDatasource,
} from "../lib/geocoder-id.ts";
import { NotFoundError, AppError } from "../lib/errors.ts";

export interface BuildingGeocoder {
  building_id: string;
  [key: string]: unknown;
}

// Resolve any input identifier (gfm-, BAG PAND, BAG NUMMERAANDUIDING, BAG legacy)
// to a canonical BAG building external_id (NL.IMBAG.PAND.*).
// Used by endpoints that key off building_id without needing the full geocoder row.
export async function resolveToBuildingId(input: string): Promise<string> {
  const datasource = fromIdentifier(input);

  switch (datasource) {
    case GeocoderDatasource.NlBagBuilding:
      return input;
    case GeocoderDatasource.NlBagLegacyBuilding: {
      const normalized = input.toUpperCase().replaceAll(" ", "");
      return `NL.IMBAG.PAND.${normalized}`;
    }
    case GeocoderDatasource.NlBagAddress:
    case GeocoderDatasource.NlBagLegacyAddress: {
      let addressId = input;
      if (datasource === GeocoderDatasource.NlBagLegacyAddress) {
        const normalized = input.toUpperCase().replaceAll(" ", "");
        addressId = `NL.IMBAG.NUMMERAANDUIDING.${normalized}`;
      }
      const result = await db.execute(sql`
        SELECT a.building_id
        FROM geocoder.address a
        WHERE a.external_id = ${addressId}
        LIMIT 1
      `);
      if (result.length === 0) throw new NotFoundError("Building not found");
      return (result[0] as { building_id: string }).building_id;
    }
    default:
      throw new AppError(400, "Unknown geocoder identifier");
  }
}

export async function getBuildingByGeocoderId(
  geocoderId: string,
): Promise<BuildingGeocoder> {
  const buildingId = await resolveToBuildingId(geocoderId);

  const rows = await db.execute(sql`
    SELECT * FROM geocoder.building_geocoder
    WHERE building_id = ${buildingId}
    LIMIT 1
  `);

  if (rows.length === 0) throw new NotFoundError("Building not found");
  return rows[0] as BuildingGeocoder;
}
