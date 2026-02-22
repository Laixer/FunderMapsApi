import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { incident } from "../../db/schema/report.ts";
import { NotFoundError } from "../../lib/errors.ts";
import type { AppEnv } from "../../types/context.ts";

const incidents = new Hono<AppEnv>();

incidents.delete("/:incident_id", async (c) => {
  const incidentId = c.req.param("incident_id");

  const existing = await db
    .select()
    .from(incident)
    .where(eq(incident.id, incidentId))
    .limit(1);

  if (existing.length === 0) throw new NotFoundError("Incident not found");

  await db.delete(incident).where(eq(incident.id, incidentId));

  return c.json({ message: "Incident deleted successfully" });
});

export default incidents;
