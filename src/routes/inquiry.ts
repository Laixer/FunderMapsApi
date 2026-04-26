import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client.ts";
import { attribution } from "../db/schema/application.ts";
import { inquiry, inquirySample } from "../db/schema/report.ts";
import { handleDocumentUpload } from "../lib/upload-handler.ts";
import type { AppEnv } from "../types/context.ts";

const inquiries = new Hono<AppEnv>();

inquiries.post("/upload-document", async (c) => {
  const result = await handleDocumentUpload(c, "inquiry-report");
  return c.json(result);
});

const createInquirySchema = z.object({
  note: z.string().optional(),
  attribution_reviewer: z.uuid(),
  attribution_contractor: z.number(),
  type: z.string(),
  document_date: z.string(),
  document_file: z.string(),
  document_name: z.string(),
  inspection: z.boolean().default(false),
  joint_measurement: z.boolean().default(false),
  floor_measurement: z.boolean().default(false),
  standard_f3o: z.boolean().default(false),
});

inquiries.post("/", zValidator("json", createInquirySchema), async (c) => {
  const data = c.req.valid("json");
  const currentUser = c.get("user");

  const result = await db.transaction(async (tx) => {
    // Create attribution
    const [attr] = await tx
      .insert(attribution)
      .values({
        reviewer: data.attribution_reviewer,
        creator: currentUser.id,
        owner: currentUser.organizations[0]?.id ?? currentUser.id,
        contractor: data.attribution_contractor,
      })
      .returning();

    // Create inquiry
    const [created] = await tx
      .insert(inquiry)
      .values({
        note: data.note?.trim() || null,
        attribution: attr!.id,
        accessPolicy: "private",
        type: data.type,
        documentDate: data.document_date,
        documentFile: data.document_file,
        documentName: data.document_name,
        inspection: data.inspection,
        jointMeasurement: data.joint_measurement,
        floorMeasurement: data.floor_measurement,
        standardF3o: data.standard_f3o,
      })
      .returning();

    return created!;
  });

  return c.json({ id: result.id }, 201);
});

inquiries.post("/:inquiry_id", async (c) => {
  const inquiryId = parseInt(c.req.param("inquiry_id"));
  const body = await c.req.json();

  const [created] = await db
    .insert(inquirySample)
    .values({
      ...body,
      inquiry: inquiryId,
    })
    .returning();

  return c.json({ id: created!.id }, 201);
});

export default inquiries;
