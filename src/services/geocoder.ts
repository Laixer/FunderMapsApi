import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  fromIdentifier,
  GeocoderDatasource,
} from "../lib/geocoder-id.ts";
import { NotFoundError, AppError } from "../lib/errors.ts";

export interface BuildingGeocoder {
  id: string;
  external_id: string;
  [key: string]: unknown;
}

export async function getBuildingByGeocoderId(
  geocoderId: string,
): Promise<BuildingGeocoder> {
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

  const rows = await db.execute(sql`
    SELECT * FROM geocoder.building_geocoder
    WHERE external_id = ${externalId}
    LIMIT 1
  `);

  if (rows.length === 0) throw new NotFoundError("Building not found");
  return rows[0] as BuildingGeocoder;
}

export async function getOldBuildingId(
  buildingId: string,
): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT id FROM geocoder.building
    WHERE external_id = ${buildingId}
    LIMIT 1
  `);
  if (result.length === 0) return null;
  return (result[0] as { id: string }).id;
}
