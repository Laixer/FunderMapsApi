import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { createIncident } from "../services/incident.ts";
import { uploadFiles } from "../services/storage.ts";

const incidents = new Hono();

const createIncidentSchema = z.object({
  client_id: z.number(),
  building: z.string(),
  foundation_type: z.string().optional(),
  chained_building: z.boolean().default(false),
  owner: z.boolean().default(false),
  foundation_recovery: z.boolean().default(false),
  neightbor_recovery: z.boolean().default(false),
  foundation_damage_cause: z.string().optional(),
  file_resource_key: z.string().optional(),
  document_file: z.array(z.string()).optional(),
  note: z.string().optional(),
  contact: z.email(),
  contact_name: z.string().optional(),
  contact_phone_number: z.string().optional(),
  environment_damage_characteristics: z.array(z.string()).optional(),
  foundation_damage_characteristics: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

incidents.post(
  "/",
  zValidator("json", createIncidentSchema),
  async (c) => {
    const data = c.req.valid("json");

    const result = await createIncident({
      clientId: data.client_id,
      building: data.building,
      foundationType: data.foundation_type,
      chainedBuilding: data.chained_building,
      owner: data.owner,
      foundationRecovery: data.foundation_recovery,
      neightborRecovery: data.neightbor_recovery,
      foundationDamageCause: data.foundation_damage_cause,
      fileResourceKey: data.file_resource_key,
      documentFile: data.document_file,
      note: data.note,
      contact: data.contact,
      contactName: data.contact_name,
      contactPhoneNumber: data.contact_phone_number,
      environmentDamageCharacteristics:
        data.environment_damage_characteristics,
      foundationDamageCharacteristics:
        data.foundation_damage_characteristics,
      metadata: data.metadata,
    });

    return c.json(result, 201);
  },
);

incidents.post("/upload", async (c) => {
  const fieldName = c.req.query("field") ?? "files";
  const formData = await c.req.formData();
  const result = await uploadFiles(formData, fieldName);
  return c.json(result);
});

export default incidents;
