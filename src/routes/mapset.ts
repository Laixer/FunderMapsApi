import { Hono } from "hono";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { mapsetCollection } from "../db/schema/application.ts";
import { organizationMapset } from "../db/schema/maplayer.ts";
import { NotFoundError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

const mapset = new Hono<AppEnv>();

mapset.get("/:mapset_id?", async (c) => {
  const mapsetId = c.req.param("mapset_id");

  if (!mapsetId) {
    // Get mapsets for user's organizations
    const currentUser = c.get("user");
    const orgIds = currentUser.organizations.map((o) => o.id);

    if (orgIds.length === 0) return c.json([]);

    const rows = await db
      .selectDistinctOn([mapsetCollection.id])
      .from(mapsetCollection)
      .innerJoin(
        organizationMapset,
        eq(mapsetCollection.id, organizationMapset.mapsetId),
      )
      .where(inArray(organizationMapset.organizationId, orgIds));

    return c.json(rows.map((r) => r.mapset_collection));
  }

  // Query by ID or slug
  const isId = mapsetId.startsWith("cl") || mapsetId.startsWith("ck");
  const rows = await db
    .select()
    .from(mapsetCollection)
    .where(
      and(
        isId
          ? eq(mapsetCollection.id, mapsetId)
          : eq(mapsetCollection.slug, mapsetId),
        eq(mapsetCollection.public, true),
      ),
    )
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("Mapset not found");
  return c.json(rows[0]);
});

export default mapset;
