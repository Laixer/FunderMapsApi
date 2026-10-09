import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { workPackageAssignment } from "../db/schema/dataops.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * Your own work packages, as the admin composed them (Vandaag).
 *
 * The admin side is PUT /api/management/work-packages/:userId. An empty list
 * means nobody composed a set for you, and the Studio falls back to the
 * packages you ticked in this browser. Under /api/dataops because the queue
 * the packages filter lives here and has the same audience
 * (authMiddleware + staffMiddleware, index.ts).
 */
const routes = new Hono<AppEnv>();

routes.get("/work-packages/me", async (c) => {
  const rows = await db
    .select({ packageId: workPackageAssignment.packageId })
    .from(workPackageAssignment)
    .where(eq(workPackageAssignment.userId, c.get("user").id))
    .orderBy(asc(workPackageAssignment.packageId));
  return c.json({ packageIds: rows.map((r) => r.packageId) });
});

export default routes;
