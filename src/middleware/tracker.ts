import { createMiddleware } from "hono/factory";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import type { AppEnv } from "../types/context.ts";

// application.product_tracker columns: (organization_id, product, building_id,
// create_date, identifier). Insert only if not already tracked in the last
// 24 hours by the same (org, product, building, identifier) combo.
export const trackerMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  await next();

  const tracker = c.get("tracker");
  if (!tracker) return;

  await db.execute(sql`
    INSERT INTO application.product_tracker (organization_id, product, building_id, identifier)
    SELECT ${tracker.organizationId}, ${tracker.product}, ${tracker.buildingId}, ${tracker.identifier}
    WHERE NOT EXISTS (
      SELECT 1 FROM application.product_tracker
      WHERE organization_id = ${tracker.organizationId}
        AND product = ${tracker.product}
        AND building_id = ${tracker.buildingId}
        AND identifier = ${tracker.identifier}
        AND create_date > now() - interval '24 hours'
    )
  `);

  c.header("X-Product-Registered", "true");
});
