import { Hono } from "hono";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { mapsetCollection } from "../db/schema/application.ts";
import { NotFoundError } from "../lib/errors.ts";
import { authMiddleware } from "../middleware/auth.ts";
import type { AppEnv } from "../types/context.ts";

const mapset = new Hono<AppEnv>();

// List the user's org's private mapsets, with geofence external_ids joined
// in. The frontend uses fence_* arrays as Mapbox layer filters so the user
// only sees buildings within their org's geolocked area. Auth-only.
mapset.get("/", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const orgIds = currentUser.organizations.map((o) => o.id);

  if (orgIds.length === 0) return c.json([]);

  // Fencing is per-mapset, least-restrictive across the orgs that GRANT the
  // mapset: if any granting org has no geolocks at all, the mapset is
  // unfenced (NULL); otherwise the fence is the union of the granting orgs'
  // locks. Orgs the user is in that don't grant the mapset get no say — the
  // previous user-level union meant joining one locked customer org fenced
  // a staff member's entire (nationwide) map to that customer's region.
  const rows = await db.execute(sql`
    WITH grants AS (
      SELECT om.mapset_id, array_agg(om.organization_id) AS org_ids
      FROM application.organization_mapset om
      WHERE ${inArray(sql`om.organization_id`, orgIds)}
      GROUP BY om.mapset_id
    ),
    fences AS (
      SELECT
        g.mapset_id,
        CASE WHEN u.unlocked THEN NULL ELSE (
          SELECT array_agg(DISTINCT neighborhood_id)
          FROM application.organization_geolock_neighborhood
          WHERE organization_id = ANY (g.org_ids)
        ) END AS fence_neighborhood,
        CASE WHEN u.unlocked THEN NULL ELSE (
          SELECT array_agg(DISTINCT district_id)
          FROM application.organization_geolock_district
          WHERE organization_id = ANY (g.org_ids)
        ) END AS fence_district,
        CASE WHEN u.unlocked THEN NULL ELSE (
          SELECT array_agg(DISTINCT municipality_id)
          FROM application.organization_geolock_municipality
          WHERE organization_id = ANY (g.org_ids)
        ) END AS fence_municipality
      FROM grants g
      CROSS JOIN LATERAL (
        -- "unlocked" = the org has no rows in ANY of the three geolock
        -- tables. An org locked at only one level (e.g. district) still
        -- counts as locked for all levels.
        SELECT EXISTS (
          SELECT 1 FROM unnest(g.org_ids) AS granting(org_id)
          WHERE NOT EXISTS (SELECT 1 FROM application.organization_geolock_municipality m WHERE m.organization_id = granting.org_id)
            AND NOT EXISTS (SELECT 1 FROM application.organization_geolock_district d WHERE d.organization_id = granting.org_id)
            AND NOT EXISTS (SELECT 1 FROM application.organization_geolock_neighborhood n WHERE n.organization_id = granting.org_id)
        ) AS unlocked
      ) u
    )
    SELECT
      c.id, c.name, c.slug, c.style, c.metadata, c.public, c.consent,
      c.note, c.icon, c."order", c.layerset,
      f.fence_neighborhood, f.fence_district, f.fence_municipality
    FROM application.mapset_collection c
    JOIN fences f ON f.mapset_id = c.id
  `);

  return c.json(rows);
});

// Public-only lookup by ID or slug. No auth, no fence join — public
// mapsets are not geolocked.
mapset.get("/:mapset_id", async (c) => {
  const mapsetId = c.req.param("mapset_id");
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
