import { Hono } from "hono";
import { asc } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { mapsetLayer } from "../../db/schema/application.ts";
import type { AppEnv } from "../../types/context.ts";

const layers = new Hono<AppEnv>();

layers.get("/", async (c) => {
  const rows = await db
    .select()
    .from(mapsetLayer)
    .orderBy(asc(mapsetLayer.order), asc(mapsetLayer.name));
  return c.json(rows);
});

export default layers;
