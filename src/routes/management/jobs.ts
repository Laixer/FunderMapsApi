import { Hono } from "hono";
import { getAllJobs, getJobById, cancelJob } from "../../services/job.ts";
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
