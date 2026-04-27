import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { resolveToBuildingId } from "../services/geocoder.ts";
import type { AppEnv } from "../types/context.ts";

const incident = new Hono<AppEnv>();

incident.get("/building/:building_id", async (c) => {
  const input = c.req.param("building_id")!;
  const buildingId = await resolveToBuildingId(input);

  const rows = await db.execute(sql`
    SELECT
      id,
      foundation_type,
      chained_building,
      owner,
      foundation_recovery,
      neighbor_recovery,
      foundation_damage_cause,
      document_file,
      note,
      internal_note,
      contact,
      contact_name,
      contact_phone_number,
      foundation_damage_characteristics,
      environment_damage_characteristics,
      building_id,
      audit_status,
      question_type,
      metadata,
      create_date,
      update_date,
      delete_date
    FROM report.incident
    WHERE building_id = ${buildingId}
    ORDER BY create_date DESC
  `);

  return c.json(rows);
});

export default incident;
