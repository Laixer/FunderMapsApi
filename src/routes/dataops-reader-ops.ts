import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.ts";
import { personLabel, seriesByKey, type DayValue } from "../lib/reader-ops.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * GET /dataops/reader-ops — the reader at work over the last 30 days, for
 * the Datastroom (2026-10-23): the Grafana board "Intake pipeline" moving into
 * the Studio (approved 2026-10-22: the pipeline boards move, then Grafana goes).
 * Same definitions as that board:
 *
 * - per day: reads by lane, failed reads, spend (USD) and k tokens, read
 *   duration p50/p95 (seconds, finished reads without an error), mails by kind
 *   (every kind found: the four known ones always, zero when quiet);
 * - totals: reads, failed, spend, the share of judged values confirmed rather
 *   than rejected, the median hours from receipt to an outcome;
 * - review effort per person (verdicts, median seconds per verdict, hours);
 * - the last 20 failed reads.
 *
 * "Day" is the Amsterdam day. Read-only, staff-only like the rest of /api/dataops.
 */
const routes = new Hono<AppEnv>();

const DAYS = 30;
const rows = <T>(r: unknown) => r as T[];
const iso = (col: SQL) => sql`to_json(${col}) #>> '{}'`;
const SINCE = sql`((date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam') - make_interval(days => ${DAYS - 1}))`;
const DAY = (col: string) => sql.raw(`to_char(${col} AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD')`);
const LANES = ["document", "text", "vision"] as const;
/** The kinds always present (zero when quiet); any other kind found is added, never dropped (risk_changed was, in #289). */
const MAIL_KINDS = ["received", "question", "closed", "risk_changed"] as const;

routes.get("/reader-ops", async (c) => {
  const [days, lanes, perDay, mails, totals, effort, failures] = await Promise.all([
    db.execute(sql`
      SELECT to_char(d, 'YYYY-MM-DD') AS day
      FROM generate_series(
        (now() AT TIME ZONE 'Europe/Amsterdam')::date::timestamp - make_interval(days => ${DAYS - 1}),
        (now() AT TIME ZONE 'Europe/Amsterdam')::date::timestamp,
        interval '1 day') AS d
      ORDER BY 1
    `),
    db.execute(sql`
      SELECT ${DAY("started_at")} AS day, lane::text AS key, count(*)::int AS value
      FROM dataops.extraction WHERE started_at >= ${SINCE} GROUP BY 1, 2
    `),
    db.execute(sql`
      SELECT ${DAY("started_at")} AS day,
        count(*) FILTER (WHERE error IS NOT NULL)::int AS failed,
        coalesce(sum(cost_usd), 0)::float AS usd,
        (coalesce(sum(input_tokens + output_tokens), 0) / 1000.0)::float AS ktokens,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at))
          FILTER (WHERE finished_at IS NOT NULL AND error IS NULL)::float AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at))
          FILTER (WHERE finished_at IS NOT NULL AND error IS NULL)::float AS p95
      FROM dataops.extraction WHERE started_at >= ${SINCE} GROUP BY 1
    `),
    db.execute(sql`
      SELECT ${DAY("coalesce(sent_at, created_at)")} AS day, kind AS key, count(*)::int AS value
      FROM dataops.dossier_mail WHERE coalesce(sent_at, created_at) >= ${SINCE} GROUP BY 1, 2
    `),
    db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM dataops.extraction WHERE started_at >= ${SINCE}) AS reads,
        (SELECT count(*)::int FROM dataops.extraction WHERE started_at >= ${SINCE} AND error IS NOT NULL) AS failed,
        (SELECT coalesce(sum(cost_usd), 0)::float FROM dataops.extraction WHERE started_at >= ${SINCE}) AS "costUsd",
        (SELECT count(*)::int FROM dataops.verdict WHERE decided_at >= ${SINCE} AND outcome IN ('confirmed', 'rejected')) AS judged,
        (SELECT count(*)::int FROM dataops.verdict WHERE decided_at >= ${SINCE} AND outcome = 'confirmed') AS confirmed,
        (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM outcome_at - received_at) / 3600)::numeric, 1)::float
           FROM dataops.dossier WHERE outcome_at >= ${SINCE} AND received_at IS NOT NULL) AS "medianDecisionHours"
    `),
    db.execute(sql`
      SELECT u.name, u.given_name AS "givenName", u.last_name AS "lastName", u.email,
        count(*)::int AS verdicts,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY v.review_seconds))::int AS "medianSeconds",
        round(sum(v.review_seconds) / 3600.0, 1)::float AS hours
      FROM dataops.verdict v LEFT JOIN application."user" u ON u.id = v.decided_by
      WHERE v.decided_at >= ${SINCE} AND v.review_seconds IS NOT NULL
      GROUP BY u.id, u.name, u.given_name, u.last_name, u.email
      ORDER BY 5 DESC
    `),
    db.execute(sql`
      SELECT ${iso(sql`e.started_at`)} AS at, e.artifact_id::int AS "artifactId", a.dossier_id::int AS "dossierId",
        a.original_filename AS name, e.lane::text AS lane, left(e.error, 160) AS error
      FROM dataops.extraction e LEFT JOIN dataops.artifact a ON a.id = e.artifact_id
      WHERE e.error IS NOT NULL AND e.started_at >= ${SINCE}
      ORDER BY e.started_at DESC LIMIT 20
    `),
  ]);

  const dayList = rows<{ day: string }>(days).map((d) => d.day);
  type Day = { day: string; failed: number; usd: number; ktokens: number; p50: number | null; p95: number | null };
  const per = rows<Day>(perDay);
  const flat = (key: keyof Omit<Day, "day">): DayValue[] => per.map((d) => ({ day: d.day, key, value: d[key] }));
  type Person = { name: string | null; givenName: string | null; lastName: string | null; email: string | null; verdicts: number; medianSeconds: number; hours: number };
  const t = rows<Record<string, number | null>>(totals)[0] ?? {};
  const mailRows = rows<DayValue>(mails);

  return c.json({
    generatedAt: new Date().toISOString(),
    days: dayList,
    series: {
      readsByLane: seriesByKey(dayList, rows<DayValue>(lanes), LANES, 0),
      ...seriesByKey(dayList, [...flat("failed"), ...flat("usd"), ...flat("ktokens")], ["failed", "usd", "ktokens"], 0),
      ...seriesByKey(dayList, [...flat("p50"), ...flat("p95")], ["p50", "p95"], null),
      mailsByKind: seriesByKey(dayList, mailRows, [...new Set([...MAIL_KINDS, ...mailRows.map((m) => m.key)])], 0),
    },
    totals: {
      reads: t.reads ?? 0,
      failed: t.failed ?? 0,
      costUsd: t.costUsd ?? 0,
      judged: t.judged ?? 0,
      confirmed: t.confirmed ?? 0,
      medianDecisionHours: t.medianDecisionHours ?? null,
    },
    effort: rows<Person>(effort).map((p) => ({ person: personLabel(p), verdicts: p.verdicts, medianSeconds: p.medianSeconds, hours: p.hours })),
    failures: rows(failures),
  });
});

export default routes;
