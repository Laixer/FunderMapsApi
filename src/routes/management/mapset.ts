import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { eq, asc, inArray } from "drizzle-orm";
import { db } from "../../db/client.ts";
import {
  mapset,
  mapsetCollection,
  mapsetLayer,
} from "../../db/schema/application.ts";
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

const replaceLayersSchema = z.object({
  layers: z.array(z.string()),
});

mapsets.put(
  "/:mapset_id/layers",
  zValidator("json", replaceLayersSchema),
  async (c) => {
    const mapsetId = c.req.param("mapset_id");
    const { layers } = c.req.valid("json");

    const exists = await db
      .select({ id: mapset.id })
      .from(mapset)
      .where(eq(mapset.id, mapsetId))
      .limit(1);
    if (exists.length === 0) throw new NotFoundError("Mapset not found");

    if (layers.length > 0) {
      const found = await db
        .select({ id: mapsetLayer.id })
        .from(mapsetLayer)
        .where(inArray(mapsetLayer.id, layers));
      const foundIds = new Set(found.map((r) => r.id));
      const missing = layers.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new NotFoundError(`Unknown layer IDs: ${missing.join(", ")}`);
      }
    }

    await db.update(mapset).set({ layers }).where(eq(mapset.id, mapsetId));
    return c.body(null, 204);
  },
);

export default mapsets;
