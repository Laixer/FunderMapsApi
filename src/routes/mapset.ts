import { Hono } from "hono";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { mapsetCollection } from "../db/schema/application.ts";
import { NotFoundError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

const mapset = new Hono<AppEnv>();

mapset.get("/:mapset_id?", async (c) => {
  const mapsetId = c.req.param("mapset_id");

  if (!mapsetId) {
    // List the user's org's private mapsets, with geofence external_ids
    // joined in. The frontend uses fence_* arrays as Mapbox layer filters
    // so the user only sees buildings within their org's geolocked area.
    const currentUser = c.get("user");
    const orgIds = currentUser.organizations.map((o) => o.id);

    if (orgIds.length === 0) return c.json([]);

    // Fence subqueries union all geolocks across every org the user is in,
    // not just whichever org-mapset row survives DISTINCT ON. Rationale: if
    // ANY of the user's orgs locks them to a region, that lock should apply
    // (most-restrictive). For Yorick (FunderMaps no-lock + Laixer locked to
    // GM0606), the previous correlated-subquery approach could pick either
    // org's fence depending on dedupe order — frequently null.
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (c.id)
        c.id, c.name, c.slug, c.style, c.metadata, c.public, c.consent,
        c.note, c.icon, c."order", c.layerset,
        (
          SELECT array_agg(DISTINCT neighborhood_id)
          FROM application.organization_geolock_neighborhood
          WHERE ${inArray(sql`organization_id`, orgIds)}
        ) AS fence_neighborhood,
        (
          SELECT array_agg(DISTINCT district_id)
          FROM application.organization_geolock_district
          WHERE ${inArray(sql`organization_id`, orgIds)}
        ) AS fence_district,
        (
          SELECT array_agg(DISTINCT municipality_id)
          FROM application.organization_geolock_municipality
          WHERE ${inArray(sql`organization_id`, orgIds)}
        ) AS fence_municipality
      FROM application.mapset_collection c
      JOIN application.organization_mapset om ON om.mapset_id = c.id
      WHERE ${inArray(sql`om.organization_id`, orgIds)}
    `);

    return c.json(rows);
  }

  // Public-only lookup by ID or slug. No fence join — public mapsets are
  // not geolocked.
  const isId = mapsetId.startsWith("cl") || mapsetId.startsWith("ck");
  const rows = await db
    .select()
    .from(mapsetCollection)
    .where(
      and(
        isId
          ? eq(mapsetCollection.id, mapsetId)
          : eq(mapsetCollection.slug, mapsetId),
        eq(mapsetCollection.public, true),
      ),
    )
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("Mapset not found");
  return c.json(rows[0]);
});

export default mapset;
