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

// Returned shape adds `layers` (the array of layer IDs from the
// underlying mapset table). The mapset_collection view exposes
// `layerset` (rich object array) but not the raw IDs — admin
// frontend needs the IDs to drive the "manage layers" UI.
mapsets.get("/", async (c) => {
  const { limit, offset } = paginationSchema.parse(c.req.query());

  const rows = await db
    .select({
      id: mapsetCollection.id,
      name: mapsetCollection.name,
      slug: mapsetCollection.slug,
      style: mapsetCollection.style,
      metadata: mapsetCollection.metadata,
      public: mapsetCollection.public,
      consent: mapsetCollection.consent,
      note: mapsetCollection.note,
      icon: mapsetCollection.icon,
      order: mapsetCollection.order,
      layerset: mapsetCollection.layerset,
      layers: mapset.layers,
    })
    .from(mapsetCollection)
    .leftJoin(mapset, eq(mapset.id, mapsetCollection.id))
    .orderBy(asc(mapsetCollection.name))
    .limit(limit)
    .offset(offset);

  return c.json(rows);
});

mapsets.get("/:mapset_id", async (c) => {
  const mapsetId = c.req.param("mapset_id");
  const rows = await db
    .select({
      id: mapsetCollection.id,
      name: mapsetCollection.name,
      slug: mapsetCollection.slug,
      style: mapsetCollection.style,
      metadata: mapsetCollection.metadata,
      public: mapsetCollection.public,
      consent: mapsetCollection.consent,
      note: mapsetCollection.note,
      icon: mapsetCollection.icon,
      order: mapsetCollection.order,
      layerset: mapsetCollection.layerset,
      layers: mapset.layers,
    })
    .from(mapsetCollection)
    .leftJoin(mapset, eq(mapset.id, mapsetCollection.id))
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
