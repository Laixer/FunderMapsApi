import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { resolveToBuildingId } from "../services/geocoder.ts";
import { meldingRows } from "../lib/incident-meldingen.ts";
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
      internal_note,
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

  // Asked for by the map app's pand panel (`?include=meldingen`). Without it the
  // answer is what it always was: the report page reads this route too.
  if (c.req.query("include") !== "meldingen") return c.json(rows);

  const meldingen = await db.execute(sql`
    SELECT coalesce(nullif(payload ->> 'topicLabel', ''), payload ->> 'topic') AS topic
    FROM dataops.dossier
    WHERE building_id = ${buildingId}
      AND payload ->> 'topic' IS NOT NULL
    ORDER BY created_at DESC
  `);

  return c.json([
    ...rows.map((row) => ({ ...row, kind: "incident" })),
    ...meldingRows(buildingId, meldingen.map((m) => (m as { topic: string | null }).topic)),
  ]);
});

export default incident;
