import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { monthsBetween } from "../../lib/data-quality.ts";
import { foldOrganizations, productMonths, type OrgWindowRow } from "../../lib/usage.ts";
import type { AppEnv } from "../../types/context.ts";

// GET /api/management/usage — what the webservice served and what the map
// application and Studio looked up, across all customers (2026-10-23). Grafana's
// two usage boards ("Usage - webservice & API", "Usage - maps & studio") moving
// into the Admin (approved 2026-10-22), administrators only like all of
// /management.
//
// The trends read the daily rollup data.product_tracker_daily (granted back to
// the API in Worker #309): the raw application.product_tracker is 26M rows,
// the rollup ~11k. The rollup runs through yesterday, so "today" and "the last
// call" come from the raw tracker, both short index reads. Which product is
// billable: lib/usage.ts.
//
// Per organization: this month (through yesterday), last month, the last 30
// days and the 30 before, and per product who calls it. API keys with when
// they were last used. Sign-ins are not here: application.session keeps only
// live sessions, so there is no history to chart; the Sessions page lists them.
const usage = new Hono<AppEnv>();

const rows = <T>(r: unknown) => r as T[];
const TODAY = sql`(now() AT TIME ZONE 'Europe/Amsterdam')::date`;

usage.get("/", async (c) => {
  const [meta, perMonth, perOrg, raw, lastCall, keys] = await Promise.all([
    db.execute(sql`
      SELECT to_char(max(day), 'YYYY-MM-DD') AS through,
        to_char(${TODAY}, 'YYYY-MM') AS this_month,
        to_char(${TODAY} - interval '12 months', 'YYYY-MM') AS first_month
      FROM data.product_tracker_daily
    `),
    db.execute(sql`
      SELECT product, to_char(date_trunc('month', day), 'YYYY-MM') AS month, sum(calls)::bigint AS calls
      FROM data.product_tracker_daily
      WHERE day >= (date_trunc('month', ${TODAY}) - interval '12 months')::date
      GROUP BY 1, 2
    `),
    db.execute(sql`
      SELECT d.organization_id::text AS id, o.name, d.product,
        sum(d.calls) FILTER (WHERE d.day >= date_trunc('month', ${TODAY})::date)::bigint AS month_to_date,
        sum(d.calls) FILTER (WHERE d.day >= (date_trunc('month', ${TODAY}) - interval '1 month')::date
                               AND d.day < date_trunc('month', ${TODAY})::date)::bigint AS last_month,
        sum(d.calls) FILTER (WHERE d.day >= ${TODAY} - 30)::bigint AS last_30_days,
        sum(d.calls) FILTER (WHERE d.day >= ${TODAY} - 60 AND d.day < ${TODAY} - 30)::bigint AS previous_30_days
      FROM data.product_tracker_daily d
      JOIN application.organization o ON o.id = d.organization_id
      WHERE d.day >= least((date_trunc('month', ${TODAY}) - interval '1 month')::date, ${TODAY} - 60)
      GROUP BY 1, 2, 3
    `),
    db.execute(sql`
      SELECT count(*) FILTER (WHERE product ~ '[34]$')::int AS webservice,
        count(*) FILTER (WHERE product !~ '[34]$')::int AS maps
      FROM application.product_tracker
      WHERE create_date >= date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam'
    `),
    db.execute(sql`
      SELECT to_json(max(create_date)) #>> '{}' AS at
      FROM application.product_tracker
      WHERE product ~ '[34]$' AND create_date > now() - interval '3 days'
    `),
    db.execute(sql`
      SELECT k.name, 'fmsk' AS kind, u.email AS owner, to_json(k.last_request) #>> '{}' AS last_used, k.request_count::int AS request_count
      FROM application.apikey k LEFT JOIN application."user" u ON u.id = k.reference_id
      WHERE k.enabled
      UNION ALL
      SELECT a.name, 'legacy', u.email, to_json(a.last_used) #>> '{}', NULL
      FROM application.auth_key a LEFT JOIN application."user" u ON u.id = a.user_id
      ORDER BY 4 DESC NULLS LAST
    `),
  ]);

  const m = rows<{ through: string | null; this_month: string; first_month: string }>(meta)[0]!;
  const months = monthsBetween(m.first_month, m.this_month);
  const monthRows = rows<{ product: string; month: string; calls: string }>(perMonth);
  const orgRows = rows<OrgWindowRow>(perOrg);
  const today = rows<{ webservice: number; maps: number }>(raw)[0] ?? { webservice: 0, maps: 0 };
  type Key = { name: string | null; kind: "fmsk" | "legacy"; owner: string | null; last_used: string | null; request_count: number | null };
  const keyRows = rows<Key>(keys);
  const staleBefore = Date.now() - 30 * 86_400_000;

  return c.json({
    generated_at: new Date().toISOString(),
    through: m.through,
    months,
    webservice: {
      calls_today: today.webservice,
      last_call_at: rows<{ at: string | null }>(lastCall)[0]?.at ?? null,
      products: productMonths(months, monthRows, "webservice"),
      organizations: foldOrganizations(orgRows, "webservice"),
    },
    maps: {
      calls_today: today.maps,
      products: productMonths(months, monthRows, "maps"),
      organizations: foldOrganizations(orgRows, "maps"),
    },
    keys: {
      active: keyRows.length,
      stale_30_days: keyRows.filter((k) => !k.last_used || Date.parse(k.last_used) < staleBefore).length,
      list: keyRows,
    },
  });
});

export default usage;
