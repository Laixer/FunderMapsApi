import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * GET /dataops/map — where the dossiers come from: per municipality how many,
 * how many became a rapportage, how many are still open, and a point to draw
 * them on (the centroid of their buildings). For the Datastroom's map
 * (2026-10-22). Municipalities by their CBS code; the gfm- ids are on their
 * way out (Worker #158).
 *
 * A dossier without a pand cannot be placed; their number comes back as
 * `unplaced`. ~1 s over 5,700 dossiers, so the answer is kept ten minutes.
 * Read-only, staff-only like the rest of /api/dataops.
 */
const routes = new Hono<AppEnv>();

type Municipality = { code: string; name: string; dossiers: number; done: number; open: number; lat: number; lon: number };
type MapAnswer = { generatedAt: string; municipalities: Municipality[]; unplaced: number; total: number };
let cached: { at: number; data: Promise<MapAnswer> } | null = null;

async function compute(): Promise<MapAnswer> {
  const [places, counts] = await Promise.all([
    db.execute(sql`
      SELECT m.external_id AS code, m.name, count(*)::int AS dossiers,
        count(*) FILTER (WHERE d.inquiry_id IS NOT NULL)::int AS done,
        count(*) FILTER (WHERE d.inquiry_id IS NULL AND d.outcome IS NULL)::int AS open,
        round(public.ST_Y(public.ST_Centroid(public.ST_Collect(public.ST_Centroid(b.geom))))::numeric, 4)::float AS lat,
        round(public.ST_X(public.ST_Centroid(public.ST_Collect(public.ST_Centroid(b.geom))))::numeric, 4)::float AS lon
      FROM dataops.dossier d
      JOIN geocoder.building b ON b.external_id = d.building_id
      JOIN geocoder.neighborhood nb ON nb.id = b.neighborhood_id
      JOIN geocoder.district di ON di.id = nb.district_id
      JOIN geocoder.municipality m ON m.id = di.municipality_id
      GROUP BY m.external_id, m.name
      ORDER BY 3 DESC
    `),
    db.execute(sql`SELECT count(*)::int AS total FROM dataops.dossier`),
  ]);
  const municipalities = places as unknown as Municipality[];
  const total = (counts as unknown as { total: number }[])[0]?.total ?? 0;
  const placed = municipalities.reduce((n, m) => n + m.dossiers, 0);
  return { generatedAt: new Date().toISOString(), municipalities, unplaced: Math.max(total - placed, 0), total };
}

routes.get("/map", async (c) => {
  if (!cached || Date.now() - cached.at > 10 * 60_000) {
    const data = compute();
    cached = { at: Date.now(), data };
    // A failed query must not stick: the next request tries again.
    data.catch(() => {
      if (cached?.data === data) cached = null;
    });
  }
  return c.json(await cached.data);
});

export default routes;
