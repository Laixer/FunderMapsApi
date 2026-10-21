import { Hono } from "hono";
import { AppError } from "../lib/errors.ts";
import { renderReportPdf } from "../lib/report-pdf/render.ts";
import type { AppEnv } from "../types/context.ts";

const pdf = new Hono<AppEnv>();

// The Typst engine, swappable in tests (routes/pdf.test.ts), the way other tests swap the methods of `db`.
export const deps = {
  renderTypst: renderReportPdf,
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

export default pdf;
