import { Hono } from "hono";
import { env } from "../config.ts";
import { AppError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

const pdf = new Hono<AppEnv>();

// Mirrors the C# PdfController. pdf.co takes the URL of a rendered HTML
// report and returns a hosted PDF. We construct the report URL from
// PDFCO_REPORT_URL + the building id; pdf.co fetches it, renders, and
// returns an `url` field which we surface as accessLink.
pdf.get("/:id", async (c) => {
  const id = c.req.param("id");

  if (!env.PDFCO_API_KEY) {
    throw new AppError(503, "PDF service not configured");
  }

  const response = await fetch(
    "https://api.pdf.co/v1/pdf/convert/from/url",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.PDFCO_API_KEY,
      },
      body: JSON.stringify({
        url: `${env.PDFCO_REPORT_URL}/${id}`,
        name: `${id}.pdf`,
        paperSize: "A4",
        async: false,
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );

  if (!response.ok) {
    throw new AppError(502, "PDF generation failed");
  }

  const result = (await response.json()) as { error?: boolean; url?: string };
  if (result.error || !result.url) {
    throw new AppError(502, "PDF generation failed");
  }

  return c.json({ accessLink: result.url });
});

export default pdf;
