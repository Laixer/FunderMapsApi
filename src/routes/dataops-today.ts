import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dailySeries, median, type DayRow } from "../lib/studio-today.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * GET /dataops/today — the Studio's day, for Vandaag (2026-10-22): most of the
 * work is done by the machines now (the reader reads, the model recalculates),
 * so the page starts with what they and the people did today, and what waits.
 *
 * - `today`: dossiers in (per channel); the reader's documents, pages, values
 *   proposed, errors and cost; verdicts by people (per outcome, the median
 *   seconds per verdict, how many people, how many of them yours); rapportages
 *   into FunderMaps; dossiers closed without one; the model's runs.
 * - `waiting`: documents nobody read yet, values waiting for a person, open
 *   dossiers.
 * - `series`: the same five counts per day for two weeks (lib/studio-today.ts).
 *
 * "Today" is the Amsterdam day. Read-only, staff-only like the rest of /api/dataops.
 */
const routes = new Hono<AppEnv>();

const DAYS = 14;
const rows = <T>(r: unknown) => r as T[];
/** Midnight in Amsterdam, as a timestamptz. */
const TODAY = sql`(date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')`;
const SINCE = sql`(${TODAY} - make_interval(days => ${DAYS - 1}))`;
const DAY = (col: string) => sql.raw(`to_char(${col} AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD')`);

routes.get("/today", async (c) => {
  const me = c.get("user").id;

  const [days, perDay, received, reader, verdicts, runs, waiting] = await Promise.all([
    db.execute(sql`
      SELECT to_char(d, 'YYYY-MM-DD') AS day
      FROM generate_series(
        (now() AT TIME ZONE 'Europe/Amsterdam')::date::timestamp - make_interval(days => ${DAYS - 1}),
        (now() AT TIME ZONE 'Europe/Amsterdam')::date::timestamp,
        interval '1 day') AS d
      ORDER BY 1
    `),
    db.execute(sql`
      SELECT ${DAY("received_at")} AS day, 'received' AS metric, count(*)::int AS n
        FROM dataops.dossier WHERE received_at >= ${SINCE} GROUP BY 1
      UNION ALL
      SELECT ${DAY("finished_at")}, 'read', count(*)::int
        FROM dataops.extraction WHERE finished_at >= ${SINCE} AND error IS NULL GROUP BY 1
      UNION ALL
      SELECT ${DAY("decided_at")}, 'judged', count(*)::int
        FROM dataops.verdict WHERE decided_at >= ${SINCE} GROUP BY 1
      UNION ALL
      SELECT ${DAY("at")}, 'committed', count(*)::int
        FROM dataops.dossier_entry WHERE at >= ${SINCE} AND text LIKE 'Overgenomen als rapportage%' GROUP BY 1
      UNION ALL
      SELECT ${DAY("outcome_at")}, 'closed', count(*)::int
        FROM dataops.dossier WHERE outcome_at >= ${SINCE} AND inquiry_id IS NULL GROUP BY 1
    `),
    db.execute(sql`
      SELECT channel::text AS channel, count(*)::int AS n
      FROM dataops.dossier WHERE received_at >= ${TODAY}
      GROUP BY 1 ORDER BY 2 DESC
    `),
    db.execute(sql`
      SELECT count(DISTINCT e.artifact_id) FILTER (WHERE e.error IS NULL)::int AS documents,
        coalesce(sum(e.pages_sent) FILTER (WHERE e.error IS NULL), 0)::int AS pages,
        count(*) FILTER (WHERE e.error IS NOT NULL)::int AS errors,
        coalesce(sum(e.cost_usd), 0)::float AS "costUsd",
        (SELECT count(*)::int FROM dataops.extraction_field f JOIN dataops.extraction x ON x.id = f.extraction_id
          WHERE x.finished_at >= ${TODAY} AND x.error IS NULL) AS proposed,
        coalesce(array_agg(DISTINCT e.model) FILTER (WHERE e.model IS NOT NULL), '{}') AS models,
        to_json(max(e.finished_at)) #>> '{}' AS "lastAt"
      FROM dataops.extraction e
      WHERE e.finished_at >= ${TODAY}
    `),
    db.execute(sql`
      SELECT outcome::text AS outcome, review_seconds AS seconds, decided_by::text AS "decidedBy"
      FROM dataops.verdict WHERE decided_at >= ${TODAY}
    `),
    db.execute(sql`
      SELECT job, status, to_json(finished_at) #>> '{}' AS "finishedAt"
      FROM data.refresh_log WHERE finished_at >= ${TODAY}
      ORDER BY finished_at
    `),
    db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM dataops.artifact a JOIN dataops.dossier d ON d.id = a.dossier_id
          WHERE d.outcome IS NULL AND d.inquiry_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM dataops.extraction e WHERE e.artifact_id = a.id)) AS "toRead",
        (SELECT count(*)::int FROM dataops.extraction_field f JOIN dataops.extraction e ON e.id = f.extraction_id
          JOIN dataops.artifact a ON a.id = e.artifact_id JOIN dataops.dossier d ON d.id = a.dossier_id
          WHERE f.state = 'pending' AND d.outcome IS NULL AND d.inquiry_id IS NULL) AS "toJudge",
        (SELECT count(*)::int FROM dataops.dossier WHERE outcome IS NULL AND inquiry_id IS NULL) AS "openDossiers"
    `),
  ]);

  type Verdict = { outcome: string; seconds: number | null; decidedBy: string | null };
  const v = rows<Verdict>(verdicts);
  const byOutcome: Record<string, number> = {};
  for (const x of v) byOutcome[x.outcome] = (byOutcome[x.outcome] ?? 0) + 1;
  const dayList = rows<{ day: string }>(days).map((d) => d.day);
  const n = (metric: string) => rows<DayRow>(perDay).filter((r) => r.day === dayList.at(-1) && r.metric === metric).reduce((a, r) => a + Number(r.n), 0);

  return c.json({
    generatedAt: new Date().toISOString(),
    day: dayList.at(-1),
    today: {
      received: { total: n("received"), byChannel: rows(received) },
      reader: rows(reader)[0] ?? null,
      judged: {
        total: v.length,
        byOutcome,
        medianSeconds: median(v.map((x) => x.seconds ?? NaN)),
        people: new Set(v.map((x) => x.decidedBy).filter(Boolean)).size,
        mine: v.filter((x) => x.decidedBy === me).length,
      },
      committed: n("committed"),
      closed: n("closed"),
      modelRuns: rows(runs),
    },
    waiting: rows(waiting)[0] ?? null,
    days: dayList,
    series: dailySeries(dayList, rows<DayRow>(perDay)),
  });
});

export default routes;
