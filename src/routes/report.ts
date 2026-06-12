import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { resolveToBuildingId } from "../services/geocoder.ts";
import { getGeofence, isBuildingInFence } from "../lib/geofence.ts";
import type { AppEnv } from "../types/context.ts";

const report = new Hono<AppEnv>();

// Aggregate read for the building-detail panel: incidents + parent inquiries
// + their samples + parent recoveries + their samples in one round-trip.
// Inquiry rows are gated by the caller's geofence (#968): inside the fence
// every org's inquiries and samples are visible; outside it only the caller's
// own orgs' rows are. Recoveries keep the legacy access_policy/owner gate.
report.get("/", async (c) => {
  const input = c.req.param("building_id")!;
  const buildingId = await resolveToBuildingId(input);
  const orgId = c.get("user").organizations[0]?.id ?? null;
  const orgIds = c.get("user").organizations.map((o) => o.id);

  const fence = await getGeofence(orgIds);
  const inFence = await isBuildingInFence(buildingId, fence);
  // Drizzle sql templates bind JS arrays as scalars — serialize to a PG
  // array literal (uuids: no quoting needed) and cast.
  const inquiryGate = inFence
    ? sql`TRUE`
    : sql`a.owner_id = ANY(${`{${orgIds.join(",")}}`}::uuid[])`;

  const [incidents, inquiries, inquirySamples, recoveries, recoverySamples] =
    await Promise.all([
      db.execute(sql`
        SELECT *
        FROM report.incident
        WHERE building_id = ${buildingId}
        ORDER BY create_date DESC
      `),
      db.execute(sql`
        SELECT
          i.id,
          i.document_name,
          i.type,
          i.document_date,
          i.document_file,
          i.note,
          i.inspection,
          i.joint_measurement,
          i.floor_measurement,
          i.standard_f3o,
          i.audit_status,
          i.access_policy,
          i.create_date,
          i.update_date,
          i.delete_date,
          a.reviewer_id AS attribution_reviewer,
          ru.email AS attribution_reviewer_name,
          a.creator_id AS attribution_creator,
          cu.email AS attribution_creator_name,
          a.owner_id AS attribution_owner,
          o.name AS attribution_owner_name,
          a.contractor_id AS attribution_contractor,
          ct.name AS attribution_contractor_name
        FROM report.inquiry i
        JOIN application.attribution a ON a.id = i.attribution_id
        LEFT JOIN application."user" ru ON ru.id = a.reviewer_id
        LEFT JOIN application."user" cu ON cu.id = a.creator_id
        LEFT JOIN application.organization o ON o.id = a.owner_id
        LEFT JOIN application.contractor ct ON ct.id = a.contractor_id
        WHERE i.id IN (
          SELECT inquiry_id FROM report.inquiry_sample WHERE building_id = ${buildingId}
        )
          AND (${inquiryGate})
        ORDER BY COALESCE(i.update_date, i.create_date) DESC
      `),
      db.execute(sql`
        SELECT s.*
        FROM report.inquiry_sample s
        JOIN report.inquiry i ON i.id = s.inquiry_id
        JOIN application.attribution a ON a.id = i.attribution_id
        WHERE s.building_id = ${buildingId}
          AND (${inquiryGate})
      `),
      db.execute(sql`
        SELECT
          r.id,
          r.document_name,
          r.type,
          r.document_date,
          r.document_file,
          r.note,
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
        FROM report.recovery r
        JOIN application.attribution a ON a.id = r.attribution_id
        LEFT JOIN application."user" ru ON ru.id = a.reviewer_id
        LEFT JOIN application."user" cu ON cu.id = a.creator_id
        LEFT JOIN application.organization o ON o.id = a.owner_id
        LEFT JOIN application.contractor ct ON ct.id = a.contractor_id
        WHERE r.id IN (
          SELECT recovery_id FROM report.recovery_sample WHERE building_id = ${buildingId}
        )
          AND (r.access_policy = 'public' OR a.owner_id = ${orgId})
        ORDER BY COALESCE(r.update_date, r.create_date) DESC
      `),
      db.execute(sql`
        SELECT s.*
        FROM report.recovery_sample s
        JOIN report.recovery r ON r.id = s.recovery_id
        JOIN application.attribution a ON a.id = r.attribution_id
        WHERE s.building_id = ${buildingId}
          AND (r.access_policy = 'public' OR a.owner_id = ${orgId})
      `),
    ]);

  return c.json({
    incidents,
    inquiries,
    inquiry_samples: inquirySamples,
    recoveries,
    recovery_samples: recoverySamples,
  });
});

export default report;
