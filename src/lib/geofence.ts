import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.ts";

// Server-side counterpart of the mapset fence (issue #968): inquiry reads are
// gated by the geographic rights of the caller's organizations, not by data
// ownership. Same semantics as /api/mapset — the fence is the union of every
// geolock row across ALL orgs the user belongs to, and an org set with no
// geolock rows at all is unrestricted (fence = null).

export type Geofence = {
  neighborhoods: string[];
  districts: string[];
  municipalities: string[];
} | null;

// Drizzle's sql template binds a JS array as a single scalar param, so
// ANY(${array}) breaks ("malformed array literal"). Serialize to a PG
// array literal and cast at the call site instead.
function pgArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(",")}}`;
}

export async function getGeofence(orgIds: string[]): Promise<Geofence> {
  if (orgIds.length === 0) return { neighborhoods: [], districts: [], municipalities: [] };

  const orgArr = pgArray(orgIds);
  const rows = (await db.execute(sql`
    SELECT 'n' AS kind, neighborhood_id AS id
    FROM application.organization_geolock_neighborhood
    WHERE organization_id = ANY(${orgArr}::uuid[])
    UNION ALL
    SELECT 'd', district_id
    FROM application.organization_geolock_district
    WHERE organization_id = ANY(${orgArr}::uuid[])
    UNION ALL
    SELECT 'm', municipality_id
    FROM application.organization_geolock_municipality
    WHERE organization_id = ANY(${orgArr}::uuid[])
  `)) as { kind: "n" | "d" | "m"; id: string }[];

  if (rows.length === 0) return null;

  return {
    neighborhoods: rows.filter((r) => r.kind === "n").map((r) => r.id),
    districts: rows.filter((r) => r.kind === "d").map((r) => r.id),
    municipalities: rows.filter((r) => r.kind === "m").map((r) => r.id),
  };
}

// True when the building lies inside the fence. `buildingId` is a BAG id
// (NL.IMBAG.PAND.…) — the id space of report.*_sample.building_id, which
// FKs geocoder.building(external_id). Geolock rows hold CBS external codes
// (BU…/WK…/GM…), so the comparison runs on external_id at each level of
// the geocoder hierarchy. Buildings without a neighborhood link (~unmapped
// stock) resolve to out-of-fence for fenced orgs — conservative by design.
export async function isBuildingInFence(
  buildingId: string,
  fence: Geofence,
): Promise<boolean> {
  if (fence === null) return true;
  const rows = await db.execute(sql`
    SELECT 1
    FROM geocoder.building b
    JOIN geocoder.neighborhood n ON n.id = b.neighborhood_id
    JOIN geocoder.district d ON d.id = n.district_id
    JOIN geocoder.municipality m ON m.id = d.municipality_id
    WHERE b.external_id = ${buildingId}
      AND (n.external_id = ANY(${pgArray(fence.neighborhoods)}::text[])
        OR d.external_id = ANY(${pgArray(fence.districts)}::text[])
        OR m.external_id = ANY(${pgArray(fence.municipalities)}::text[]))
    LIMIT 1
  `);
  return rows.length > 0;
}

// SQL predicate: the inquiry (correlated through `inquiryIdExpr`, typically
// the Drizzle `inquiry.id` column of the outer query) has at least one sample
// on a building inside the fence. Only valid when fence !== null — callers
// must skip the predicate entirely for unfenced users.
export function inquiryInFenceSql(
  fence: NonNullable<Geofence>,
  inquiryIdExpr: SQL | { getSQL(): SQL },
): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM report.inquiry_sample fs
    JOIN geocoder.building fb ON fb.external_id = fs.building_id
    JOIN geocoder.neighborhood fn ON fn.id = fb.neighborhood_id
    JOIN geocoder.district fd ON fd.id = fn.district_id
    JOIN geocoder.municipality fm ON fm.id = fd.municipality_id
    WHERE fs.inquiry_id = ${inquiryIdExpr}
      AND (fn.external_id = ANY(${pgArray(fence.neighborhoods)}::text[])
        OR fd.external_id = ANY(${pgArray(fence.districts)}::text[])
        OR fm.external_id = ANY(${pgArray(fence.municipalities)}::text[]))
  )`;
}
