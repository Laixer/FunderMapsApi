import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { application } from "../db/schema/application.ts";
import { env } from "../config.ts";
import { NotFoundError } from "../lib/errors.ts";

const app = new Hono();

app.get("/:application_id?", async (c) => {
  let appId = c.req.param("application_id") ?? env.APP_ID;
  if (!appId.startsWith("app-")) {
    appId = `app-${appId}`;
  }

  const rows = await db
    .select()
    .from(application)
    .where(eq(application.applicationId, appId))
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("Application not found");

  c.header("Cache-Control", "public, max-age=3600");
  return c.json(rows[0]);
});

export default app;
