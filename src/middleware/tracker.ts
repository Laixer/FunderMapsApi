import { createMiddleware } from "hono/factory";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import type { AppEnv } from "../types/context.ts";

export const trackerMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  await next();

  const tracker = c.get("tracker");
  if (!tracker) return;

  // Insert only if not already tracked in the last 24 hours
  await db.execute(sql`
    INSERT INTO application.product_tracker (name, building_id, identifier)
    SELECT ${tracker.name}, ${tracker.buildingId}, ${tracker.identifier}
    WHERE NOT EXISTS (
      SELECT 1 FROM application.product_tracker
      WHERE name = ${tracker.name}
        AND building_id = ${tracker.buildingId}
        AND identifier = ${tracker.identifier}
    )
  `);

  c.header("X-Product-Registered", "true");
});
