import { eq, and, sql, desc, asc } from "drizzle-orm";
import { db } from "../db/client.ts";
import { workerJob } from "../db/schema/application.ts";
import { NotFoundError, AppError } from "../lib/errors.ts";

export interface CreateJobInput {
  jobType: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  processAfter?: Date;
}

export async function createJob(input: CreateJobInput) {
  const [job] = await db
    .insert(workerJob)
    .values({
      jobType: input.jobType,
      payload: input.payload,
      priority: input.priority ?? 0,
      maxRetries: input.maxRetries ?? 3,
      processAfter: input.processAfter,
    })
    .returning();
  return job!;
}

export interface GetJobsOptions {
  jobType?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function getAllJobs(options: GetJobsOptions = {}) {
  const conditions = [];
  if (options.jobType) {
    conditions.push(eq(workerJob.jobType, options.jobType));
  }
  if (options.status) {
    conditions.push(sql`${workerJob.status} = ${options.status}`);
  }

  const query = db
    .select()
    .from(workerJob)
    .orderBy(desc(workerJob.priority), asc(workerJob.createdAt))
    .limit(options.limit ?? 100)
    .offset(options.offset ?? 0);

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}

export async function getJobById(id: number) {
  const rows = await db
    .select()
    .from(workerJob)
    .where(eq(workerJob.id, id))
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("Job not found");
  return rows[0]!;
}

export async function cancelJob(id: number) {
  const job = await getJobById(id);

  if (job.status !== "pending" && job.status !== "retry") {
    throw new AppError(400, "Can only cancel pending or retry jobs");
  }

  const [updated] = await db
    .update(workerJob)
    .set({
      status: "failed",
      lastError: "Cancelled by admin",
      updatedAt: new Date(),
    })
    .where(eq(workerJob.id, id))
    .returning();

  return updated!;
}
