import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { eq, asc } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { application } from "../../db/schema/application.ts";
import { paginationSchema } from "../../lib/pagination.ts";
import { NotFoundError } from "../../lib/errors.ts";
import type { AppEnv } from "../../types/context.ts";

const apps = new Hono<AppEnv>();

apps.get("/", async (c) => {
  const { limit, offset } = paginationSchema.parse(c.req.query());

  const rows = await db
    .select()
    .from(application)
    .orderBy(asc(application.name))
    .limit(limit)
    .offset(offset);

  return c.json(rows);
});

const createAppSchema = z.object({
  name: z.string().min(1),
});

apps.post("/", zValidator("json", createAppSchema), async (c) => {
  const data = c.req.valid("json");

  const [created] = await db
    .insert(application)
    .values({ applicationId: `app-${crypto.randomUUID()}`, name: data.name })
    .returning();

  return c.json(created, 201);
});

apps.get("/:app_id", async (c) => {
  const appId = c.req.param("app_id");
  const rows = await db
    .select()
    .from(application)
    .where(eq(application.applicationId, appId))
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("Application not found");
  return c.json(rows[0]);
});

const updateAppSchema = z.object({
  name: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
  redirect_url: z.string().optional(),
  public: z.boolean().optional(),
  user_id: z.string().optional(),
});

apps.put("/:app_id", zValidator("json", updateAppSchema), async (c) => {
  const appId = c.req.param("app_id");
  const input = c.req.valid("json");

  const [updated] = await db
    .update(application)
    .set({
      name: input.name,
      data: input.data,
      redirectUrl: input.redirect_url,
      public: input.public,
      userId: input.user_id,
    })
    .where(eq(application.applicationId, appId))
    .returning();

  if (!updated) throw new NotFoundError("Application not found");
  return c.json(updated);
});

export default apps;
