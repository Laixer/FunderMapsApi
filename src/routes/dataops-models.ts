import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { riskSpread, runGrid, type ClassRow, type RunRow } from "../lib/model-runs.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * GET /dataops/models — the model's runs over the last 14 days and the spread
 * of the served model's labels (lib/model-runs.ts), for the Studio's
 * "Modellen" page. Read-only, staff-only like the rest of /api/dataops.
 *
 * The spread scans the served model (~11 million rows, ~3 s), so it is kept
 * in memory until a newer refresh has finished. The runs are read each time.
 */
const routes = new Hono<AppEnv>();
const DAYS = 14;

const rows = <T>(r: unknown) => r as T[];
const iso = (col: ReturnType<typeof sql>) => sql`to_json(${col}) #>> '{}'`;

type Spread = {
  refreshedAt: string | null;
  computedAt: string;
  total: number;
  foundationType: { type: string | null; n: number }[];
  risks: ReturnType<typeof riskSpread>;
};
let spreadCache: { refreshedAt: string | null; data: Promise<Spread> } | null = null;

async function computeSpread(refreshedAt: string | null): Promise<Spread> {
  const [types, classes] = await Promise.all([
    db.execute(sql`SELECT foundation_type::text AS type, count(*)::int AS n FROM data.model_risk_static GROUP BY 1 ORDER BY 2 DESC`),
    db.execute(sql`
      SELECT r.risk, r.klass, count(*)::int AS n
      FROM data.model_risk_static m
      CROSS JOIN LATERAL (VALUES
        ('drystand', m.drystand_risk::text),
        ('dewatering_depth', m.dewatering_depth_risk::text),
        ('bio_infection', m.bio_infection_risk::text),
        ('unclassified', m.unclassified_risk::text)
      ) AS r(risk, klass)
      GROUP BY 1, 2
    `),
  ]);
  const foundationType = rows<{ type: string | null; n: number }>(types);
  return {
    refreshedAt,
    computedAt: new Date().toISOString(),
    total: foundationType.reduce((s, t) => s + t.n, 0),
    foundationType,
    risks: riskSpread(rows<ClassRow>(classes)),
  };
}

routes.get("/models", async (c) => {
  const [runs, days, exportsRows, nowRow] = await Promise.all([
    db.execute(sql`
      SELECT to_char(finished_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD') AS day,
        extract(hour FROM finished_at AT TIME ZONE 'Europe/Amsterdam')::int AS hour,
        status, ${iso(sql`finished_at`)} AS "finishedAt"
      FROM data.refresh_log
      WHERE job = 'refresh_data_model' AND finished_at >= now() - make_interval(days => ${DAYS})
      ORDER BY finished_at
    `),
    db.execute(sql`
      SELECT to_char(d, 'YYYY-MM-DD') AS day
      FROM generate_series(
        (now() AT TIME ZONE 'Europe/Amsterdam')::date::timestamp - make_interval(days => ${DAYS - 1}),
        (now() AT TIME ZONE 'Europe/Amsterdam')::date::timestamp,
        interval '1 day'
      ) AS d
      ORDER BY 1
    `),
    db.execute(sql`
      SELECT DISTINCT ON (detail->>'tileset') detail->>'tileset' AS tileset, (detail->>'seconds')::int AS seconds,
        (detail->>'bytes')::bigint AS bytes, (detail->>'features')::int AS features, ${iso(sql`finished_at`)} AS "finishedAt"
      FROM data.refresh_log
      WHERE job = 'export_tileset' AND status = 'ok'
      ORDER BY detail->>'tileset', finished_at DESC
    `),
    db.execute(sql`
      SELECT to_char(now() AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD') AS day,
        extract(hour FROM now() AT TIME ZONE 'Europe/Amsterdam')::int AS hour
    `),
  ]);

  const runList = rows<RunRow>(runs);
  const refreshedAt = runList.filter((r) => r.status === "ok").at(-1)?.finishedAt ?? null;
  if (!spreadCache || spreadCache.refreshedAt !== refreshedAt) {
    const data = computeSpread(refreshedAt);
    spreadCache = { refreshedAt, data };
    // A failed scan must not stick: the next request tries again.
    data.catch(() => {
      if (spreadCache?.data === data) spreadCache = null;
    });
  }

  return c.json({
    grid: runGrid(rows<{ day: string }>(days).map((d) => d.day), runList, rows<{ day: string; hour: number }>(nowRow)[0]!),
    exports: rows<{ tileset: string; seconds: number; bytes: number; features: number; finishedAt: string }>(exportsRows),
    spread: await spreadCache.data,
  });
});

export default routes;
