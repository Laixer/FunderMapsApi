import { Hono } from "hono";
import { env } from "../config.ts";
import { AppError } from "../lib/errors.ts";
import { mintReportToken } from "../lib/report-token.ts";
import type { AppEnv } from "../types/context.ts";

const pdf = new Hono<AppEnv>();

// Sync render: POST returns PDF bytes inline. Gotenberg renders the report
// front-end URL in headless Chromium and streams the result back. The
// `waitForExpression` blocks rasterization until the report SPA sets
// `<html data-pdf-ready="true">` — without it chart-heavy pages render
// half-painted.
pdf.post("/:id", async (c) => {
  const id = c.req.param("id");

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

  const response = await fetch(
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
    },
  });
});

export default pdf;
