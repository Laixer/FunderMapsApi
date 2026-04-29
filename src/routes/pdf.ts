import { Hono } from "hono";
import { env } from "../config.ts";
import { AppError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

const pdf = new Hono<AppEnv>();

// pdf.co takes the URL of a rendered HTML report and returns a hosted PDF.
// Async mode: POST submits the job and returns {jobId}; the frontend polls
// GET /job/:job_id (proxies pdf.co's /v1/job/check) until status is success,
// then downloads the accessLink. Decouples request lifetime from PDF render
// time — some chart-heavy reports take >2 min, exceeding DO App Platform's
// HTTP request timeout.

pdf.post("/:id", async (c) => {
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
        async: true,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new AppError(502, "PDF job submission failed");
  }

  const result = (await response.json()) as {
    error?: boolean;
    jobId?: string;
  };
  if (result.error || !result.jobId) {
    throw new AppError(502, "PDF job submission failed");
  }

  return c.json({ jobId: result.jobId });
});

pdf.get("/job/:job_id", async (c) => {
  const jobId = c.req.param("job_id");

  if (!env.PDFCO_API_KEY) {
    throw new AppError(503, "PDF service not configured");
  }

  const response = await fetch("https://api.pdf.co/v1/job/check", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.PDFCO_API_KEY,
    },
    body: JSON.stringify({ jobid: jobId }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new AppError(502, "PDF job status check failed");
  }

  const result = (await response.json()) as {
    error?: boolean;
    status?: string;
    url?: string;
  };
  if (result.error) {
    throw new AppError(502, "PDF job status check failed");
  }

  // pdf.co statuses: working, success, failed, aborted, unknown.
  // Collapse anything non-terminal to 'working' for the client.
  const status =
    result.status === "success" || result.status === "failed"
      ? result.status
      : "working";

  return c.json({
    status,
    accessLink: status === "success" ? result.url : undefined,
  });
});

export default pdf;
