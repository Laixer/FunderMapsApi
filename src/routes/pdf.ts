import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { env } from "../config.ts";
import { db } from "../db/client.ts";
import { billingOrgId } from "../lib/auth-helpers.ts";
import { AppError } from "../lib/errors.ts";
import { renderReportPdf } from "../lib/report-pdf/render.ts";
import { mintReportToken } from "../lib/report-token.ts";
import { loadUserWithOrgs } from "../middleware/auth.ts";
import type { AppEnv } from "../types/context.ts";

const pdf = new Hono<AppEnv>();

// The Typst engine, the billing step and the call to Gotenberg, swappable in tests (routes/pdf.test.ts),
// the way other tests swap the methods of `db`.
export const deps = {
  renderTypst: renderReportPdf,
  track: (buildingId: string) => trackLikeTheReportPage(buildingId),
  fetch: (input: string, init: RequestInit) => fetch(input, init),
};

// POST /api/pdf/:id returns the funderingsrisicorapport as PDF bytes inline.
// Two engines (env PDF_ENGINE, per request ?engine=typst|gotenberg):
//   typst      (default) made in this process: src/lib/report-pdf/. When it fails for another reason than
//              missing data, the request falls back to Gotenberg, so a user still gets a report.
//   gotenberg  the report front-end, rendered by Gotenberg in headless Chromium.
pdf.post("/:id", async (c) => {
  const id = c.req.param("id");
  const asked = c.req.query("engine");
  const engine = asked === "gotenberg" || asked === "typst" ? asked : env.PDF_ENGINE;
  if (engine === "gotenberg") return gotenberg(c, id);

  let report;
  try {
    report = await deps.renderTypst(id);
  } catch (err) {
    if (err instanceof AppError) throw err; // no such pand, or no report data: a 404 either way
    console.error(`pdf: typst failed for ${id}, falling back to Gotenberg:`, err);
    if (!env.GOTENBERG_URL) throw new AppError(502, "PDF generation failed");
    return gotenberg(c, id);
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

// The billing rows a report writes. Through Gotenberg the report page reads /product/:id/analysis and
// /statistics as the report service account, and trackerMiddleware writes one row for each (24-hour dedup).
// The Typst report reads the same data itself, so it writes the same two rows: product_tracker stays the same
// billing record whichever engine made the PDF.
async function trackLikeTheReportPage(buildingId: string) {
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

// Sync render through Gotenberg: it renders the report front-end URL in headless Chromium and streams the
// result back. The `waitForExpression` blocks rasterization until the report SPA sets
// `<html data-pdf-ready="true">` — without it chart-heavy pages render half-painted.
async function gotenberg(c: Context<AppEnv>, id: string): Promise<Response> {
  if (!env.GOTENBERG_URL) {
    throw new AppError(503, "PDF service not configured");
  }

  // The report reads its data with a render token minted here: 5 minutes,
  // this pand only, GET only (lib/report-token.ts). It travels in the URL
  // fragment, which the browser never sends to a server, so it stays out of
  // every access log. Without the secret the page falls back to its own key.
  let url = `${env.REPORT_RENDER_URL}/${encodeURIComponent(id)}`;
  if (env.REPORT_TOKEN_SECRET && env.REPORT_SERVICE_USER_ID) {
    url += `#t=${mintReportToken(id, c.get("user").id, env.REPORT_TOKEN_SECRET)}`;
  }

  const form = new FormData();
  form.append("url", url);
  form.append("paperWidth", "8.27");
  form.append("paperHeight", "11.69");
  form.append("marginTop", "10mm");
  form.append("marginBottom", "10mm");
  form.append("marginLeft", "10mm");
  form.append("marginRight", "10mm");
  form.append(
    "waitForExpression",
    "document.documentElement.getAttribute('data-pdf-ready') === 'true'",
  );

  const headers: Record<string, string> = {};
  if (env.GOTENBERG_USERNAME && env.GOTENBERG_PASSWORD) {
    headers.Authorization = `Basic ${btoa(
      `${env.GOTENBERG_USERNAME}:${env.GOTENBERG_PASSWORD}`,
    )}`;
  }

  const response = await deps.fetch(
    `${env.GOTENBERG_URL}/forms/chromium/convert/url`,
    {
      method: "POST",
      headers,
      body: form,
      // Stay under Bun.serve's max idleTimeout (255s) — see src/index.ts.
      signal: AbortSignal.timeout(240_000),
    },
  );

  if (!response.ok) {
    throw new AppError(502, "PDF generation failed");
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${id}.pdf"`,
      "X-Pdf-Engine": "gotenberg",
    },
  });
}

export default pdf;
