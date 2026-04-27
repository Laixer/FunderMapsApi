import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { attribution } from "../db/schema/application.ts";
import { recovery, recoverySample } from "../db/schema/report.ts";
import { handleDocumentUpload } from "../lib/upload-handler.ts";
import { getDownloadUrl } from "../lib/s3.ts";
import { resolveToBuildingId } from "../services/geocoder.ts";
import { NotFoundError, AppError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

const recoveries = new Hono<AppEnv>();

recoveries.get("/building/:building_id", async (c) => {
  const input = c.req.param("building_id")!;
  const buildingId = await resolveToBuildingId(input);

  const rows = await db.execute(sql`
    SELECT
      r.id,
      r.note,
      r.type,
      r.document_date,
      r.document_file,
      r.document_name,
      r.audit_status,
      r.access_policy,
      r.create_date,
      r.update_date,
      r.delete_date,
      a.reviewer_id AS attribution_reviewer,
      ru.email AS attribution_reviewer_name,
      a.creator_id AS attribution_creator,
      cu.email AS attribution_creator_name,
      a.owner_id AS attribution_owner,
      o.name AS attribution_owner_name,
      a.contractor_id AS attribution_contractor,
      ct.name AS attribution_contractor_name
    FROM report.recovery_sample s
    JOIN report.recovery r ON r.id = s.recovery_id
    JOIN application.attribution a ON a.id = r.attribution_id
    LEFT JOIN application."user" ru ON ru.id = a.reviewer_id
    LEFT JOIN application."user" cu ON cu.id = a.creator_id
    LEFT JOIN application.organization o ON o.id = a.owner_id
    LEFT JOIN application.contractor ct ON ct.id = a.contractor_id
    WHERE s.building_id = ${buildingId}
    GROUP BY
      r.id, a.reviewer_id, ru.email, a.creator_id, cu.email,
      a.owner_id, o.name, a.contractor_id, ct.name
    ORDER BY COALESCE(r.update_date, r.create_date) DESC
  `);

  return c.json(rows);
});

recoveries.get("/:recovery_id/sample", async (c) => {
  const recoveryId = parseInt(c.req.param("recovery_id"));
  if (Number.isNaN(recoveryId))
    throw new AppError(400, "Invalid recovery ID");

  const rows = await db.execute(sql`
    SELECT
      id, recovery_id, note, status, type, pile_type, facade,
      permit, permit_date, recovery_date, contractor_id, building_id,
      metadata, create_date, update_date, delete_date
    FROM report.recovery_sample
    WHERE recovery_id = ${recoveryId}
    ORDER BY create_date
  `);

  return c.json(rows);
});

recoveries.get("/:recovery_id/download", async (c) => {
  const recoveryId = parseInt(c.req.param("recovery_id"));
  if (Number.isNaN(recoveryId))
    throw new AppError(400, "Invalid recovery ID");

  const orgId = c.get("user").organizations[0]?.id;
  if (!orgId) throw new AppError(403, "User has no organization");

  const rows = await db.execute(sql`
    SELECT r.document_file
    FROM report.recovery r
    JOIN application.attribution a ON a.id = r.attribution_id
    WHERE r.id = ${recoveryId} AND a.owner_id = ${orgId}
    LIMIT 1
  `);

  if (rows.length === 0) throw new NotFoundError("Recovery not found");

  const documentFile = (rows[0] as { document_file: string }).document_file;
  const accessLink = await getDownloadUrl(documentFile);
  return c.json({ accessLink });
});

recoveries.post("/upload-document", async (c) => {
  const result = await handleDocumentUpload(c, "recovery-report");
  return c.json(result);
});

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
