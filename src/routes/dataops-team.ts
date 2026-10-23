import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { ForbiddenError } from "../lib/errors.ts";
import { personLabel, seriesByKey, type DayValue } from "../lib/reader-ops.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * GET /dataops/team — who did what in the last 30 Amsterdam days, for the
 * administrators' part of Vandaag (2026-10-23): the per-person panels of
 * Grafana's "Operations" board ("Active days per person", "Rapportages created
 * per day, per person", samples, verdicts, dossiers closed).
 *
 * Administrators only — decided in the terminal on 2026-10-23 ("keep
 * per-person admin only"); anyone else gets a 403, like /reader-ops sends
 * them no per-person rows (#291).
 *
 * Per person: rapportages and samples created under their name (that includes
 * what they took over in Controle: accepting a dossier makes the rapportage
 * in the reviewer's name), values judged, dossiers they closed, the days on
 * which they did any of it, and their actions per day. The board's "reviewed
 * into the database" column is left out: there is no moment of review on a
 * rapportage, only its creation date, so it would count by the wrong day.
 * Dossiers the system closed itself (duplicates, nothing found) are one
 * number apart, not a person.
 */
const routes = new Hono<AppEnv>();

const DAYS = 30;
const rows = <T>(r: unknown) => r as T[];
const SINCE = sql`((date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam') - make_interval(days => ${DAYS - 1}))`;
const DAY = (col: string) => sql.raw(`to_char(${col} AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD')`);

routes.get("/team", async (c) => {
  if (c.get("user")?.role !== "administrator") throw new ForbiddenError("who did what is for administrators");

  const [days, acts, people, system] = await Promise.all([
    db.execute(sql`
      SELECT to_char(d, 'YYYY-MM-DD') AS day
      FROM generate_series(
        (now() AT TIME ZONE 'Europe/Amsterdam')::date::timestamp - make_interval(days => ${DAYS - 1}),
        (now() AT TIME ZONE 'Europe/Amsterdam')::date::timestamp,
        interval '1 day') AS d
      ORDER BY 1
    `),
    db.execute(sql`
      WITH acts AS (
        SELECT a.creator_id AS uid, ${DAY("i.create_date")} AS day, 'rapportages' AS kind
        FROM report.inquiry i JOIN application.attribution a ON a.id = i.attribution_id
        WHERE i.create_date >= ${SINCE}
        UNION ALL
        SELECT a.creator_id, ${DAY("s.create_date")}, 'samples'
        FROM report.inquiry_sample s JOIN report.inquiry i ON i.id = s.inquiry_id JOIN application.attribution a ON a.id = i.attribution_id
        WHERE s.create_date >= ${SINCE}
        UNION ALL
        SELECT v.decided_by, ${DAY("v.decided_at")}, 'verdicts'
        FROM dataops.verdict v WHERE v.decided_at >= ${SINCE}
        UNION ALL
        SELECT CASE WHEN e.actor ~ '^[0-9a-f-]{36}$' THEN e.actor::uuid END, ${DAY("e.at")}, 'closed'
        FROM dataops.dossier_entry e
        WHERE e.kind = 'status' AND e.actor_kind = 'reviewer' AND e.body ? 'outcome' AND e.at >= ${SINCE}
      )
      SELECT uid::text AS uid, day, kind, count(*)::int AS n FROM acts WHERE uid IS NOT NULL GROUP BY 1, 2, 3
    `),
    db.execute(sql`SELECT id::text AS id, name, given_name AS "givenName", last_name AS "lastName", email FROM application."user"`),
    db.execute(sql`
      SELECT count(*)::int AS closed FROM dataops.dossier_entry e
      WHERE e.kind = 'status' AND e.actor_kind = 'system' AND e.body ? 'outcome' AND e.at >= ${SINCE}
    `),
  ]);

  const dayList = rows<{ day: string }>(days).map((d) => d.day);
  const act = rows<{ uid: string; day: string; kind: string; n: number }>(acts);
  const names = new Map(rows<{ id: string; name: string | null; givenName: string | null; lastName: string | null; email: string | null }>(people).map((p) => [p.id, p]));
  const KINDS = ["rapportages", "samples", "verdicts", "closed"] as const;

  const team = [...new Set(act.map((a) => a.uid))].map((uid) => {
    const mine = act.filter((a) => a.uid === uid);
    const total = (k: string) => mine.filter((a) => a.kind === k).reduce((n, a) => n + a.n, 0);
    const perDay = seriesByKey(dayList, mine.map((a): DayValue => ({ day: a.day, key: "all", value: a.n })), ["all"], 0).all ?? [];
    const p = names.get(uid);
    return {
      person: p ? personLabel(p) : "onbekend",
      ...Object.fromEntries(KINDS.map((k) => [k, total(k)])),
      activeDays: new Set(mine.map((a) => a.day)).size,
      perDay,
    } as { person: string; rapportages: number; samples: number; verdicts: number; closed: number; activeDays: number; perDay: number[] };
  }).sort((a, b) => b.activeDays - a.activeDays || b.verdicts + b.rapportages - (a.verdicts + a.rapportages) || a.person.localeCompare(b.person));

  return c.json({
    generatedAt: new Date().toISOString(),
    days: dayList,
    team,
    systemClosed: rows<{ closed: number }>(system)[0]?.closed ?? 0,
  });
});

export default routes;
