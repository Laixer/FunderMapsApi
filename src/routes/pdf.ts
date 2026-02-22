import { Hono } from "hono";
import { env } from "../config.ts";
import { AppError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

const pdf = new Hono<AppEnv>();

pdf.get("/:id", async (c) => {
  const id = c.req.param("id");

  if (!env.PDF_SERVICE_URL) {
    throw new AppError(500, "PDF service not configured");
  }

  const response = await fetch(env.PDF_SERVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: id,
      name: `${id}.pdf`,
      paperSize: "A4",
      async: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new AppError(500, "PDF generation failed");
  }

  const result = (await response.json()) as { url: string };
  return c.json({ url: result.url });
});

export default pdf;
