import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { foldSubjects, yearsFrom, type SubjectRow, type YearRow } from "../lib/feedback.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * GET /dataops/feedback — terugmeldingen: what owners and advisers report back
 * about a building's foundation information (convenant point 6), for the
 * Datastroom (2026-10-23). The Grafana board "Terugmeldingen" moving into the
 * Studio (approved 2026-10-22), with that board's definitions:
 *
 * - three sources: the incident portal (report.incident, since 2014), the
 *   FunderConsult archive (dossier channel bulk_drop) and melden.fundermaps.com
 *   (channel upload); an audit dossier is not a terugmelding;
 * - per year, portal and melden only: the archive's received_at is the day it
 *   was delivered (2026), not the day of the report, so a year chart of it would
 *   tell a story that did not happen;
 * - handled (an outcome) as a share of archive + melden, the open ones, the
 *   median hours from receipt to an outcome on melden, the risk-recalculated
 *   mails sent;
 * - melden per subject (per-dossier follow-ups folded into one), how many were
 *   handled and how many led to a rapportage.
 *
 * Read-only, staff-only like the rest of /api/dataops.
 */
const routes = new Hono<AppEnv>();

const FIRST_YEAR = 2014;
const rows = <T>(r: unknown) => r as T[];
const FEEDBACK = sql`audit_inquiry_id IS NULL`;

routes.get("/feedback", async (c) => {
  const [totals, years, subjects] = await Promise.all([
    db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM report.incident WHERE delete_date IS NULL) AS portal,
        (SELECT count(*)::int FROM dataops.dossier WHERE channel = 'bulk_drop' AND ${FEEDBACK}) AS archive,
        (SELECT count(*)::int FROM dataops.dossier WHERE channel = 'upload' AND ${FEEDBACK}) AS melden,
        (SELECT count(*) FILTER (WHERE outcome IS NOT NULL)::int FROM dataops.dossier WHERE channel IN ('upload', 'bulk_drop') AND ${FEEDBACK}) AS handled,
        (SELECT count(*) FILTER (WHERE outcome IS NULL)::int FROM dataops.dossier WHERE channel IN ('upload', 'bulk_drop') AND ${FEEDBACK}) AS open,
        (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM outcome_at - received_at) / 3600)::numeric, 1)::float
           FROM dataops.dossier WHERE channel = 'upload' AND outcome_at IS NOT NULL AND ${FEEDBACK}) AS "meldenMedianHours",
        (SELECT count(*)::int FROM dataops.dossier_mail WHERE kind = 'risk_changed' AND status = 'sent') AS "riskMailed",
        (SELECT to_json(min(coalesce(sent_at, created_at))) #>> '{}' FROM dataops.dossier_mail WHERE kind = 'risk_changed' AND status = 'sent') AS "riskMailedSince",
        extract(year FROM now() AT TIME ZONE 'Europe/Amsterdam')::int AS "thisYear"
    `),
    db.execute(sql`
      WITH src AS (
        SELECT 'portal' AS bron, create_date AS ts FROM report.incident WHERE delete_date IS NULL
        UNION ALL SELECT 'melden', received_at FROM dataops.dossier WHERE channel = 'upload' AND ${FEEDBACK}
      )
      SELECT to_char(ts AT TIME ZONE 'Europe/Amsterdam', 'YYYY') AS year,
        count(*) FILTER (WHERE bron = 'portal')::int AS portal,
        count(*) FILTER (WHERE bron = 'melden')::int AS melden
      FROM src WHERE ts IS NOT NULL GROUP BY 1
    `),
    db.execute(sql`
      SELECT subject, count(*)::int AS received,
        count(*) FILTER (WHERE outcome IS NOT NULL)::int AS handled,
        count(*) FILTER (WHERE inquiry_id IS NOT NULL)::int AS "ledToReport"
      FROM dataops.dossier WHERE channel = 'upload' AND ${FEEDBACK}
      GROUP BY 1
    `),
  ]);

  type Totals = { portal: number; archive: number; melden: number; handled: number; open: number; meldenMedianHours: number | null; riskMailed: number; riskMailedSince: string | null; thisYear: number };
  const t = rows<Totals>(totals)[0]!;
  const handledOf = t.handled + t.open;

  return c.json({
    generatedAt: new Date().toISOString(),
    totals: {
      all: t.portal + t.archive + t.melden,
      portal: t.portal,
      archive: t.archive,
      melden: t.melden,
      handled: t.handled,
      open: t.open,
      handledShare: handledOf ? t.handled / handledOf : null,
      meldenMedianHours: t.meldenMedianHours,
      riskMailed: t.riskMailed,
      riskMailedSince: t.riskMailedSince,
    },
    perYear: yearsFrom(FIRST_YEAR, t.thisYear, rows<YearRow>(years)),
    subjects: foldSubjects(rows<SubjectRow>(subjects)),
  });
});

export default routes;
