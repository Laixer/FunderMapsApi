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

export async function getBuildingByGeocoderId(
  geocoderId: string,
): Promise<BuildingGeocoder> {
  const datasource = fromIdentifier(geocoderId);

  let buildingId: string;

  switch (datasource) {
    case GeocoderDatasource.NlBagBuilding:
      buildingId = geocoderId;
      break;
    case GeocoderDatasource.NlBagLegacyBuilding: {
      const normalized = geocoderId.toUpperCase().replaceAll(" ", "");
      buildingId = `NL.IMBAG.PAND.${normalized}`;
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
        SELECT a.building_id
        FROM geocoder.address a
        WHERE a.external_id = ${addressId}
        LIMIT 1
      `);
      if (result.length === 0) throw new NotFoundError("Building not found");
      buildingId = (result[0] as { building_id: string }).building_id;
      break;
    }
    default:
      throw new AppError(400, "Unknown geocoder identifier");
  }

  const rows = await db.execute(sql`
    SELECT * FROM geocoder.building_geocoder
    WHERE building_id = ${buildingId}
    LIMIT 1
  `);

  if (rows.length === 0) throw new NotFoundError("Building not found");
  return rows[0] as BuildingGeocoder;
}
