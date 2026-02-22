import { Hono } from "hono";
import { eq, asc } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { mapsetCollection } from "../../db/schema/application.ts";
import { paginationSchema } from "../../lib/pagination.ts";
import { NotFoundError } from "../../lib/errors.ts";
import type { AppEnv } from "../../types/context.ts";

const mapsets = new Hono<AppEnv>();

mapsets.get("/", async (c) => {
  const { limit, offset } = paginationSchema.parse(c.req.query());

  const rows = await db
    .select()
    .from(mapsetCollection)
    .orderBy(asc(mapsetCollection.name))
    .limit(limit)
    .offset(offset);

  return c.json(rows);
});

mapsets.get("/:mapset_id", async (c) => {
  const mapsetId = c.req.param("mapset_id");
  const rows = await db
    .select()
    .from(mapsetCollection)
    .where(eq(mapsetCollection.id, mapsetId))
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("Mapset not found");
  return c.json(rows[0]);
});

export default mapsets;
