import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * GET /dataops/buildings — the panden with open work, for the Studio's
 * "Panden" finder (2026-10-22: "The pand page is really important … both how
 * it looks and how easy it is to navigate to"). One row per pand that has a
 * dossier on the desk: its first address, its municipality, how many dossiers
 * are open and in all, and when the last one came in. Newest first, the first
 * 50; `total` says how many panden have open work.
 *
 * Read-only, staff-only like the rest of /api/dataops.
 */
const routes = new Hono<AppEnv>();

const LIMIT = 50;
/** ISO 8601 (to_json), which every browser parses. */
const iso = (col: SQL) => sql`to_json(${col}) #>> '{}'`;

routes.get("/buildings", async (c) => {
  const rows = await db.execute(sql`
    WITH open AS (
      SELECT building_id, count(*)::int AS open, max(received_at) AS last
      FROM dataops.dossier
      WHERE outcome IS NULL AND inquiry_id IS NULL AND building_id IS NOT NULL
      GROUP BY 1
    )
    SELECT o.building_id AS id, o.open, ${iso(sql`o.last`)} AS "lastReceived",
      count(*) OVER ()::int AS total,
      (SELECT count(*)::int FROM dataops.dossier d WHERE d.building_id = o.building_id) AS dossiers,
      a.street, a.building_number AS number, a.city,
      m.name AS municipality
    FROM open o
    LEFT JOIN LATERAL (
      SELECT street, building_number, city FROM geocoder.address
      WHERE building_id = o.building_id ORDER BY external_id LIMIT 1
    ) a ON true
    LEFT JOIN geocoder.building b ON b.external_id = o.building_id
    LEFT JOIN geocoder.neighborhood n ON n.id = b.neighborhood_id
    LEFT JOIN geocoder.district di ON di.id = n.district_id
    LEFT JOIN geocoder.municipality m ON m.id = di.municipality_id
    ORDER BY o.last DESC, o.building_id
    LIMIT ${LIMIT}
  `);
  type Row = { id: string; open: number; lastReceived: string; total: number; dossiers: number; street: string | null; number: string | null; city: string | null; municipality: string | null };
  const list = rows as unknown as Row[];
  return c.json({
    generatedAt: new Date().toISOString(),
    total: list[0]?.total ?? 0,
    open: list.map(({ total: _total, ...r }) => r),
  });
});

export default routes;
