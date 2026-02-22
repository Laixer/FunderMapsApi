import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import type { AppEnv } from "../types/context.ts";

const report = new Hono<AppEnv>();

report.get("/", async (c) => {
  const buildingId = c.req.param("building_id");

  const [incidents, inquirySamples, recoverySamples] = await Promise.all([
    db.execute(sql`
      SELECT i.*
      FROM report.incident i
      JOIN geocoder.building b ON b.id = i.building
      WHERE b.external_id = ${buildingId}
    `),
    db.execute(sql`
      SELECT s.*
      FROM report.inquiry_sample s
      JOIN geocoder.building b ON b.id = s.building
      WHERE b.external_id = ${buildingId}
    `),
    db.execute(sql`
      SELECT s.*
      FROM report.recovery_sample s
      WHERE s.building_id = ${buildingId}
    `),
  ]);

  return c.json({
    incidents,
    inquiries: [],
    inquiry_samples: inquirySamples,
    recoveries: [],
    recovery_samples: recoverySamples,
  });
});

export default report;
