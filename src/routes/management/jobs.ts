import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { createJob, getAllJobs, getJobById, cancelJob } from "../../services/job.ts";
import type { AppEnv } from "../../types/context.ts";

// Map Drizzle's camelCase shape to the snake_case wire format the
// legacy ManagementFront IJob expects — same Go-compat treatment as
// toLegacyUser does for users.
type JobRow = Awaited<ReturnType<typeof getJobById>>;

function toLegacyJob(j: JobRow) {
  return {
    id: j.id,
    job_type: j.jobType,
    payload: j.payload ?? null,
    status: j.status,
    priority: j.priority,
    retry_count: j.retryCount,
    max_retries: j.maxRetries,
    last_error: j.lastError ?? null,
    process_after: j.processAfter ? new Date(j.processAfter).toISOString() : null,
    created_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    updated_at: j.updatedAt ? new Date(j.updatedAt).toISOString() : null,
  };
}

const jobs = new Hono<AppEnv>();

jobs.get("/", async (c) => {
  const jobType = c.req.query("job_type");
  const status = c.req.query("status");
  const limit = parseInt(c.req.query("limit") ?? "100");
  const offset = parseInt(c.req.query("offset") ?? "0");

  const rows = await getAllJobs({ jobType, status, limit, offset });
  return c.json(rows.map(toLegacyJob));
});

// Canonical form is underscore — matches what `data.refresh_all` writes and
// the Worker dispatch table. Worker normalizes `-` → `_` for backward
// compat; mirror that here so a typo gets a 400 at the boundary instead of
// burying an "Unknown job type" failure in the worker_jobs table.
//
// `process_mapset` (tile rendering) is the only job the Worker still runs from
// the queue. The former export/pdf/mail/cleanup jobs moved to Windmill, and
// BAG ingest (`load_dataset`) is now a direct Worker CLI call — none of them
// are dispatched via worker_jobs anymore, so enqueuing them here would just
// leave a row nothing consumes.
const JOB_TYPES = ["process_mapset"] as const;

const createJobSchema = z.object({
  job_type: z
    .string()
    .transform((v) => v.replace(/-/g, "_"))
    .pipe(z.enum(JOB_TYPES)),
  payload: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().optional(),
  max_retries: z.number().optional(),
  process_after: z.string().optional(),
});

jobs.post("/", zValidator("json", createJobSchema), async (c) => {
  const data = c.req.valid("json");

  const job = await createJob({
    jobType: data.job_type,
    payload: data.payload,
    priority: data.priority,
    maxRetries: data.max_retries,
    processAfter: data.process_after ? new Date(data.process_after) : undefined,
  });

  return c.json(toLegacyJob(job), 201);
});

jobs.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const job = await getJobById(id);
  return c.json(toLegacyJob(job));
});

jobs.post("/:id/cancel", async (c) => {
  const id = parseInt(c.req.param("id"));
  const job = await cancelJob(id);
  return c.json(toLegacyJob(job));
});

export default jobs;
