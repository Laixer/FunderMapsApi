import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { along, camel, FOUNDATION_FIELDS, monthsBetween, QUICKSCAN_REQUIRED } from "../lib/data-quality.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * GET /dataops/data-quality — what is in FunderMaps, how it got there and how
 * complete it is, for the Studio's Datakwaliteit page (2026-10-23). The Grafana
 * board "Data quality" moving into the Studio (approved 2026-10-22), with its
 * definitions, and one correction: the board's "new samples per month" read
 * create_date, which carries whole imports on single days. Here that series is
 * "added to FunderMaps", with the import days named, beside a second one on the
 * report's own date (lib/data-quality.ts).
 *
 * - totals: rapportages, samples, recoveries, recovery samples, the oldest report;
 * - samples added per month since 2019, and the days with 5,000 or more;
 * - rapportages per year of the report, those before 1900 as one;
 * - per inquiry type: rapportages, samples, samples added in the last 12 months;
 * - rapportages per audit status;
 * - QuickScans (facade_scan) per month, last 24: samples and complete ones
 *   (QUICKSCAN_REQUIRED all filled), per required field how often it is filled
 *   (last 12 months), and the latest 20 incomplete ones;
 * - foundation research: per field, the share of samples with it filled;
 * - samples per bureau, added in the last 12 months.
 *
 * Read-only, staff-only like the rest of /api/dataops. No person in it.
 */
const routes = new Hono<AppEnv>();

const rows = <T>(r: unknown) => r as T[];
const FIRST_MONTH = "2019-01";
const BIG_IMPORT = 5000;
const col = (c: string) => sql.raw(`s.${c}`);
const QS_COMPLETE = sql.join(QUICKSCAN_REQUIRED.map((c) => sql`${col(c)} IS NOT NULL`), sql` AND `);

routes.get("/data-quality", async (c) => {
  const [totals, added, imports, docYears, byType, audit, qsMonths, qsIncomplete, qsFill, fill, bureaus] = await Promise.all([
    db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM report.inquiry) AS inquiries,
        (SELECT count(*)::int FROM report.inquiry_sample) AS samples,
        (SELECT count(*)::int FROM report.recovery) AS recoveries,
        (SELECT count(*)::int FROM report.recovery_sample) AS "recoverySamples",
        (SELECT extract(year FROM min(document_date))::int FROM report.inquiry) AS "oldestYear",
        to_char(now() AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM') AS "thisMonth"
    `),
    db.execute(sql`
      SELECT to_char(create_date, 'YYYY-MM') AS key, count(*)::int AS value
      FROM report.inquiry_sample WHERE create_date >= ${`${FIRST_MONTH}-01`}::date GROUP BY 1
    `),
    db.execute(sql`
      SELECT to_char(create_date::date, 'YYYY-MM-DD') AS day, count(*)::int AS samples
      FROM report.inquiry_sample GROUP BY create_date::date HAVING count(*) >= ${BIG_IMPORT}
      ORDER BY 1
    `),
    db.execute(sql`
      SELECT CASE WHEN extract(year FROM document_date) < 1900 THEN 'before1900' ELSE to_char(document_date, 'YYYY') END AS key,
        count(*)::int AS value
      FROM report.inquiry WHERE document_date IS NOT NULL GROUP BY 1
    `),
    db.execute(sql`
      SELECT i.type::text AS type, count(DISTINCT i.id)::int AS inquiries, count(s.id)::int AS samples,
        count(s.id) FILTER (WHERE s.create_date >= now() - interval '12 months')::int AS "addedLastYear"
      FROM report.inquiry i LEFT JOIN report.inquiry_sample s ON s.inquiry_id = i.id
      GROUP BY 1 ORDER BY 2 DESC
    `),
    db.execute(sql`SELECT audit_status::text AS status, count(*)::int AS inquiries FROM report.inquiry GROUP BY 1 ORDER BY 2 DESC`),
    db.execute(sql`
      SELECT to_char(s.create_date, 'YYYY-MM') AS month, count(*)::int AS samples,
        count(*) FILTER (WHERE ${QS_COMPLETE})::int AS complete
      FROM report.inquiry_sample s JOIN report.inquiry i ON i.id = s.inquiry_id
      WHERE i.type = 'facade_scan' AND s.create_date >= date_trunc('month', now()) - interval '23 months'
      GROUP BY 1
    `),
    db.execute(sql`
      SELECT s.inquiry_id::int AS "inquiryId", s.id::int AS "sampleId", to_json(s.create_date) #>> '{}' AS at,
        i.document_name AS "documentName",
        array_remove(ARRAY[${sql.join(QUICKSCAN_REQUIRED.map((f) => sql`CASE WHEN ${col(f)} IS NULL THEN ${camel(f)} END`), sql`, `)}], NULL) AS missing
      FROM report.inquiry_sample s JOIN report.inquiry i ON i.id = s.inquiry_id
      WHERE i.type = 'facade_scan' AND NOT (${QS_COMPLETE})
      ORDER BY s.create_date DESC, s.id DESC LIMIT 20
    `),
    db.execute(sql`
      SELECT count(*)::int AS total, ${sql.join(QUICKSCAN_REQUIRED.map((f) => sql`count(${col(f)})::int AS ${sql.identifier(f)}`), sql`, `)}
      FROM report.inquiry_sample s JOIN report.inquiry i ON i.id = s.inquiry_id
      WHERE i.type = 'facade_scan' AND s.create_date >= now() - interval '12 months'
    `),
    db.execute(sql`
      SELECT count(*)::int AS total, ${sql.join(FOUNDATION_FIELDS.map((f) => sql`count(${col(f)})::int AS ${sql.identifier(f)}`), sql`, `)}
      FROM report.inquiry_sample s JOIN report.inquiry i ON i.id = s.inquiry_id
      WHERE i.type = 'foundation_research'
    `),
    db.execute(sql`
      SELECT c.name, count(*)::int AS samples
      FROM report.inquiry_sample s JOIN report.inquiry i ON i.id = s.inquiry_id
      JOIN application.attribution a ON a.id = i.attribution_id
      LEFT JOIN application.contractor c ON c.id = a.contractor_id
      WHERE s.create_date >= now() - interval '12 months'
      GROUP BY c.id, c.name ORDER BY 2 DESC LIMIT 15
    `),
  ]);

  type Totals = { inquiries: number; samples: number; recoveries: number; recoverySamples: number; oldestYear: number | null; thisMonth: string };
  const t = rows<Totals>(totals)[0]!;
  const months = monthsBetween(FIRST_MONTH, t.thisMonth);
  const thisYear = Number(t.thisMonth.slice(0, 4));
  const years = ["before1900", ...Array.from({ length: thisYear - 1899 }, (_, i) => String(1900 + i))];
  const qs24 = months.slice(-24);
  const qs = rows<{ month: string; samples: number; complete: number }>(qsMonths);
  const f = rows<Record<string, number>>(fill)[0] ?? {};
  const qf = rows<Record<string, number>>(qsFill)[0] ?? {};

  return c.json({
    generatedAt: new Date().toISOString(),
    totals: { inquiries: t.inquiries, samples: t.samples, recoveries: t.recoveries, recoverySamples: t.recoverySamples, oldestYear: t.oldestYear },
    added: { months, samples: along(months, rows(added)), imports: rows(imports), importThreshold: BIG_IMPORT },
    documentYears: { years, inquiries: along(years, rows(docYears)) },
    byType: rows(byType),
    auditStatus: rows(audit),
    quickscan: {
      required: QUICKSCAN_REQUIRED.map(camel),
      months: qs24,
      samples: along(qs24, qs.map((r) => ({ key: r.month, value: r.samples }))),
      complete: along(qs24, qs.map((r) => ({ key: r.month, value: r.complete }))),
      incomplete: rows(qsIncomplete),
      // Which of the required fields are filled, last 12 months: says WHICH part is missing, not just that one is.
      fieldFill: { total: qf.total ?? 0, fields: QUICKSCAN_REQUIRED.map((k) => ({ field: camel(k), filled: qf[k] ?? 0 })) },
    },
    foundationFill: {
      total: f.total ?? 0,
      fields: FOUNDATION_FIELDS.map((k) => ({ field: camel(k), filled: f[k] ?? 0 })),
    },
    bureaus: rows<{ name: string | null; samples: number }>(bureaus),
  });
});

export default routes;
