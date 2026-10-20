import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { env } from "../config.ts";
import { db } from "../db/client.ts";
import { billingOrgId } from "../lib/auth-helpers.ts";
import { AppError } from "../lib/errors.ts";
import { renderReportPdf } from "../lib/report-pdf/render.ts";
import { loadUserWithOrgs } from "../middleware/auth.ts";
import type { AppEnv } from "../types/context.ts";

const pdf = new Hono<AppEnv>();

// The Typst engine and the billing step, swappable in tests (routes/pdf.test.ts), the way other tests swap
// the methods of `db`.
export const deps = {
  renderTypst: renderReportPdf,
  track: (buildingId: string) => trackReportBilling(buildingId),
};

// POST /api/pdf/:id returns the funderingsrisicorapport as PDF bytes inline, made in this process with Typst
// (src/lib/report-pdf/). The report site and Gotenberg that made it before were deleted on 2026-10-20.
pdf.post("/:id", async (c) => {
  const id = c.req.param("id");
  let report;
  try {
    report = await deps.renderTypst(id);
  } catch (err) {
    if (err instanceof AppError) throw err; // no such pand, or no report data: a 404 either way
    console.error(`pdf: typst failed for ${id}:`, err);
    throw new AppError(502, "PDF generation failed");
  }
  await deps.track(report.buildingId);
  console.log(`pdf: typst ${report.buildingId} ${report.pdf.length} B · data ${report.ms.data} ms, maps ${report.ms.maps} ms, typst ${report.ms.typst} ms`);
  return new Response(report.pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${id}.pdf"`,
      "X-Pdf-Engine": "typst",
    },
  });
});

// The billing rows a report writes: one analysis and one statistics row for the report service account
// (24-hour dedup), the two rows the old report page wrote through trackerMiddleware when it read
// /product/:id/analysis and /statistics. product_tracker is the billing record, so it stays the same.
async function trackReportBilling(buildingId: string) {
  if (!env.REPORT_SERVICE_USER_ID) return;
  const service = await loadUserWithOrgs(env.REPORT_SERVICE_USER_ID);
  const orgId = service ? billingOrgId(service) : undefined;
  if (!service || !orgId) return;
  for (const product of ["analysis", "statistics"]) {
    await db.execute(sql`
      INSERT INTO application.product_tracker (organization_id, product, building_id, identifier)
      SELECT ${orgId}, ${product}, ${buildingId}, ${service.id}
      WHERE NOT EXISTS (
        SELECT 1 FROM application.product_tracker
        WHERE organization_id = ${orgId}
          AND product = ${product}
          AND building_id = ${buildingId}
          AND identifier = ${service.id}
          AND create_date > now() - interval '24 hours'
      )
    `);
  }
}

export default pdf;
