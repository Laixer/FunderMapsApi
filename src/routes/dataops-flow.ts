import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { addUp, weekly } from "../lib/dataops-flow.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * The Datastroom: where every dossier went, per channel, and how many came in
 * and were closed per week. Read-only, one round of grouped queries (~40 ms on
 * the 5,699 dossiers of 2026-10-22). Staff-only like the rest of /api/dataops
 * (authMiddleware + staffMiddleware, index.ts).
 *
 * The database groups by yes/no facts; `flowBucket` (lib/dataops-flow.ts)
 * decides the bucket, so the rule lives in one tested place.
 */
const routes = new Hono<AppEnv>();

const WEEKS = 12;

routes.get("/flow", async (c) => {
  const [groups, received, closed, weeks] = await Promise.all([
    db.execute(sql`
      WITH files AS (
        SELECT a.dossier_id, count(*) AS n FROM dataops.artifact a GROUP BY 1
      ), reads AS (
        SELECT DISTINCT a.dossier_id FROM dataops.extraction e JOIN dataops.artifact a ON a.id = e.artifact_id
      ), fields AS (
        SELECT a.dossier_id,
          count(*) FILTER (WHERE f.state <> 'superseded') AS found,
          count(*) FILTER (WHERE f.state IN ('pending', 'auto_accepted', 'rejected')) AS open
        FROM dataops.extraction_field f
        JOIN dataops.extraction e ON e.id = f.extraction_id
        JOIN dataops.artifact a ON a.id = e.artifact_id
        GROUP BY 1
      )
      SELECT
        d.channel::text AS channel,
        d.inquiry_id IS NOT NULL AS inquiry,
        d.outcome::text AS outcome,
        coalesce(files.n, 0) > 0 AS files,
        reads.dossier_id IS NOT NULL AS read,
        coalesce(fields.found, 0) > 0 AS found,
        coalesce(fields.open, 0) > 0 AS open,
        count(*)::int AS count
      FROM dataops.dossier d
      LEFT JOIN files ON files.dossier_id = d.id
      LEFT JOIN reads ON reads.dossier_id = d.id
      LEFT JOIN fields ON fields.dossier_id = d.id
      GROUP BY 1, 2, 3, 4, 5, 6, 7
    `),
    db.execute(sql`
      SELECT to_char(date_trunc('week', received_at), 'YYYY-MM-DD') AS week, channel::text AS channel, count(*)::int AS count
      FROM dataops.dossier
      WHERE received_at >= date_trunc('week', now()) - make_interval(weeks => ${WEEKS - 1})
      GROUP BY 1, 2
    `),
    db.execute(sql`
      SELECT to_char(date_trunc('week', outcome_at), 'YYYY-MM-DD') AS week, channel::text AS channel, count(*)::int AS count
      FROM dataops.dossier
      WHERE outcome_at >= date_trunc('week', now()) - make_interval(weeks => ${WEEKS - 1})
      GROUP BY 1, 2
    `),
    db.execute(sql`
      SELECT to_char(w, 'YYYY-MM-DD') AS week
      FROM generate_series(date_trunc('week', now()) - make_interval(weeks => ${WEEKS - 1}), date_trunc('week', now()), interval '1 week') AS w
      ORDER BY 1
    `),
  ]);

  type Group = { channel: string; inquiry: boolean; outcome: string | null; files: boolean; read: boolean; found: boolean; open: boolean; count: number };
  type Week = { week: string; channel: string; count: number };
  const weekList = (weeks as unknown as { week: string }[]).map((w) => w.week);

  return c.json({
    generatedAt: new Date().toISOString(),
    flow: addUp(groups as unknown as Group[]),
    weeks: weekList,
    weekly: weekly(weekList, received as unknown as Week[], closed as unknown as Week[]),
  });
});

export default routes;
