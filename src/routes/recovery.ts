import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client.ts";
import { attribution } from "../db/schema/application.ts";
import { recovery, recoverySample } from "../db/schema/report.ts";
import type { AppEnv } from "../types/context.ts";

const recoveries = new Hono<AppEnv>();

const createRecoverySchema = z.object({
  note: z.string().optional(),
  access_policy: z.enum(["public", "private"]),
  type: z.string(),
  document_date: z.string(),
  document_file: z.string(),
  document_name: z.string(),
  attribution_reviewer: z.uuid(),
  attribution_contractor: z.number().optional(),
});

recoveries.post("/", zValidator("json", createRecoverySchema), async (c) => {
  const data = c.req.valid("json");
  const currentUser = c.get("user");

  const result = await db.transaction(async (tx) => {
    const [attr] = await tx
      .insert(attribution)
      .values({
        reviewer: data.attribution_reviewer,
        creator: currentUser.id,
        owner: currentUser.organizations[0]?.id ?? currentUser.id,
        contractor: data.attribution_contractor ?? 0,
      })
      .returning();

    const [created] = await tx
      .insert(recovery)
      .values({
        note: data.note?.trim() || null,
        attribution: attr!.id,
        accessPolicy: data.access_policy,
        type: data.type,
        documentDate: data.document_date,
        documentFile: data.document_file,
        documentName: data.document_name,
      })
      .returning();

    return created!;
  });

  return c.json({ id: result.id }, 201);
});

recoveries.post("/:recovery_id", async (c) => {
  const recoveryId = parseInt(c.req.param("recovery_id"));
  const body = await c.req.json();

  const [created] = await db
    .insert(recoverySample)
    .values({
      ...body,
      recovery: recoveryId,
    })
    .returning();

  return c.json({ id: created!.id }, 201);
});

export default recoveries;
