import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { eq, and, count, exists, ilike, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client.ts";
import {
  attribution,
  contractor,
  organization,
  user,
} from "../db/schema/application.ts";
import { inquiry, inquirySample } from "../db/schema/report.ts";
import { address as geocoderAddress } from "../db/schema/geocoder.ts";
import { handleDocumentUpload } from "../lib/upload-handler.ts";
import { assertCanWrite, assertCanReview, assertCanAdmin } from "../lib/auth-helpers.ts";
import { intToEnum } from "../lib/inquiry-enums.ts";
import {
  toLegacyInquiry,
  type AttributionView,
} from "../lib/inquiry-serializer.ts";
import { getDownloadUrl } from "../lib/s3.ts";
import { NotFoundError, ForbiddenError, ValidationError } from "../lib/errors.ts";
import {
  sendApprovedEmail,
  sendRejectedEmail,
  sendReviewRequestedEmail,
  type InquiryEmailContext,
} from "../lib/inquiry-emails.ts";
import type { AppEnv } from "../types/context.ts";

const inquiries = new Hono<AppEnv>();

const reviewerU = alias(user, "reviewer_u");
const creatorU = alias(user, "creator_u");
const dataOwnerOrg = alias(organization, "data_owner_org");

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function activeOrgId(c: Context<AppEnv>): string {
  const orgId = c.get("user").organizations[0]?.id;
  if (!orgId) {
    throw new ForbiddenError("User is not a member of any organization");
  }
  return orgId;
}

// Single source of truth for the JOIN that backs every Inquiry response.
// Returns Drizzle row {inquiry, attr: AttributionView} for one or many rows.
function inquirySelector() {
  return db
    .select({
      inquiry,
      attr: {
        reviewer: attribution.reviewer,
        reviewerName: reviewerU.email,
        creator: attribution.creator,
        creatorName: creatorU.email,
        owner: attribution.owner,
        ownerName: organization.name,
        dataOwner: inquiry.dataOwnerOrganization,
        dataOwnerName: dataOwnerOrg.name,
        contractor: attribution.contractor,
        contractorName: contractor.name,
      },
    })
    .from(inquiry)
    .innerJoin(attribution, eq(attribution.id, inquiry.attribution))
    .innerJoin(reviewerU, eq(reviewerU.id, attribution.reviewer))
    .innerJoin(creatorU, eq(creatorU.id, attribution.creator))
    .innerJoin(organization, eq(organization.id, attribution.owner))
    .leftJoin(dataOwnerOrg, eq(dataOwnerOrg.id, inquiry.dataOwnerOrganization))
    .innerJoin(contractor, eq(contractor.id, attribution.contractor));
}

async function loadInquiryScoped(
  id: number,
  orgId: string,
): Promise<{ row: typeof inquiry.$inferSelect; attr: AttributionView }> {
  const [hit] = await inquirySelector()
    .where(and(eq(inquiry.id, id), eq(inquiry.dataOwnerOrganization, orgId)))
    .limit(1);
  if (!hit) throw new NotFoundError("Inquiry not found");
  return { row: hit.inquiry, attr: hit.attr };
}

// Ownership-agnostic lookup (issue #968): inquiry source files are downloadable
// by any logged-in user, not just the owning organization.
async function loadInquiryUnscoped(
  id: number,
): Promise<{ row: typeof inquiry.$inferSelect; attr: AttributionView }> {
  const [hit] = await inquirySelector().where(eq(inquiry.id, id)).limit(1);
  if (!hit) throw new NotFoundError("Inquiry not found");
  return { row: hit.inquiry, attr: hit.attr };
}

function requireWritable(row: typeof inquiry.$inferSelect) {
  const allowed = ["todo", "pending", "rejected"];
  if (!row.auditStatus || !allowed.includes(row.auditStatus)) {
    throw new ForbiddenError(
      `Inquiry is read-only in state '${row.auditStatus}'`,
    );
  }
}

// Returns the new audit_status string or throws StateTransitionException-like.
function transitionStatus(
  current: string | null,
  target: "pending" | "pending_review" | "done" | "rejected" | "todo",
): string {
  const cur = current ?? "todo";
  const allowed: Record<typeof target, string[]> = {
    pending: [], // any → pending always allowed (used by reset + sample-create)
    pending_review: ["pending"],
    done: ["pending_review"],
    rejected: ["pending_review"],
    todo: ["pending"],
  };
  if (target !== "pending" && !allowed[target].includes(cur)) {
    throw new ValidationError([
      `Illegal audit-status transition: ${cur} → ${target}`,
    ]);
  }
  return target;
}

async function emailContext(
  inq: typeof inquiry.$inferSelect,
  attr: AttributionView,
): Promise<InquiryEmailContext> {
  // Stub helper kept for future Mailgun wiring; current emails are no-ops.
  return {
    inquiryId: inq.id,
    documentName: inq.documentName,
    creatorEmail: attr.creatorName ?? "",
    creatorName: attr.creatorName ?? "",
    reviewerEmail: attr.reviewerName ?? "",
    reviewerName: attr.reviewerName ?? "",
    organizationName: attr.ownerName ?? "",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Wave 2: upload-document (literal route — must register before /:id-style)
// ─────────────────────────────────────────────────────────────────────────

inquiries.post("/upload-document", async (c) => {
  const result = await handleDocumentUpload(c, "inquiry-report");
  return c.json(result);
});

// ─────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────

inquiries.get("/stats", async (c) => {
  const orgId = activeOrgId(c);
  const [stat] = await db
    .select({ value: count() })
    .from(inquiry)
    .innerJoin(attribution, eq(attribution.id, inquiry.attribution))
    .where(eq(inquiry.dataOwnerOrganization, orgId));
  return c.json({ count: Number(stat?.value ?? 0) });
});

inquiries.get("/building/:bid", async (c) => {
  const orgId = activeOrgId(c);
  const buildingId = c.req.param("bid");
  const limit = parseInt(c.req.query("limit") ?? "100");
  const offset = parseInt(c.req.query("offset") ?? "0");

  const rows = await inquirySelector()
    .innerJoin(inquirySample, eq(inquirySample.inquiry, inquiry.id))
    .where(
      and(
        eq(inquirySample.building, buildingId),
        eq(inquiry.dataOwnerOrganization, orgId),
      ),
    )
    .groupBy(
      inquiry.id,
      attribution.reviewer,
      reviewerU.email,
      attribution.creator,
      creatorU.email,
      attribution.owner,
      organization.name,
      dataOwnerOrg.name,
      attribution.contractor,
      contractor.name,
    )
    .orderBy(sql`coalesce(${inquiry.updateDate}, ${inquiry.createDate}) DESC`)
    .limit(limit)
    .offset(offset);

  return c.json(rows.map((r) => toLegacyInquiry(r.inquiry, r.attr)));
});

inquiries.get("/", async (c) => {
  const orgId = activeOrgId(c);
  const q = c.req.query("q")?.trim();
  // When searching, default to a larger ceiling so the staff actually see
  // their matches; bare browse stays at 100. Caller can still override.
  const defaultLimit = q ? 500 : 100;
  const limit = parseInt(c.req.query("limit") ?? String(defaultLimit));
  const offset = parseInt(c.req.query("offset") ?? "0");

  const where: SQL[] = [eq(inquiry.dataOwnerOrganization, orgId)];
  if (q) where.push(buildInquirySearchPredicate(q));

  const rows = await inquirySelector()
    .where(and(...where))
    .orderBy(sql`coalesce(${inquiry.updateDate}, ${inquiry.createDate}) DESC`)
    .limit(limit)
    .offset(offset);

  return c.json(rows.map((r) => toLegacyInquiry(r.inquiry, r.attr)));
});

// Search across id (numeric exact), document_name, and any of the sample's
// address/building identifiers. The sample subquery covers gfm-* ids (the
// `address` column references geocoder.address.id), BAG NUMMERAANDUIDING
// (geocoder.address.external_id), and BAG PAND (inquirySample.building).
function buildInquirySearchPredicate(q: string): SQL {
  // BAG identifiers contain long digit runs (e.g. "0202100000216966") that
  // overflow int32 — only treat as an ID match when it fits.
  const asInt = /^\d+$/.test(q) ? Number(q) : NaN;
  const numericId = Number.isSafeInteger(asInt) && asInt <= 2147483647 ? asInt : null;

  // Fast path for an exact id lookup. Keeping the text predicates in the
  // same OR clause caused the planner to fall off the PK index and scan
  // the whole org (13s in prod for a single-row lookup). When the user
  // types a plain int, that's an id query — short-circuit on it.
  if (numericId != null) {
    return eq(inquiry.id, numericId);
  }

  const like = `%${q}%`;
  const sampleMatch = exists(
    db
      .select({ x: sql`1` })
      .from(inquirySample)
      .leftJoin(geocoderAddress, eq(geocoderAddress.id, inquirySample.address))
      .where(
        and(
          eq(inquirySample.inquiry, inquiry.id),
          or(
            ilike(inquirySample.address, like),
            ilike(inquirySample.building, like),
            ilike(geocoderAddress.externalId, like),
          ),
        ),
      ),
  );

  return or(ilike(inquiry.documentName, like), sampleMatch)!;
}

inquiries.get("/:id{[0-9]+}", async (c) => {
  const id = parseInt(c.req.param("id"));
  const orgId = activeOrgId(c);
  const { row, attr } = await loadInquiryScoped(id, orgId);
  return c.json(toLegacyInquiry(row, attr));
});

inquiries.get("/:id{[0-9]+}/download", async (c) => {
  const id = parseInt(c.req.param("id"));
  const { row } = await loadInquiryUnscoped(id);
  const link = await getDownloadUrl(`inquiry-report/${row.documentFile}`, 1);
  return c.json({ accessLink: link });
});

// ─────────────────────────────────────────────────────────────────────────
// Writes — body shape mirrors what ClientApp sends (camelCase, nested
// attribution, integer enums)
// ─────────────────────────────────────────────────────────────────────────

const inquiryBodySchema = z.object({
  documentName: z.string().min(1),
  inspection: z.boolean().optional(),
  jointMeasurement: z.boolean().optional(),
  floorMeasurement: z.boolean().optional(),
  note: z.string().nullish(),
  documentDate: z.string(),
  documentFile: z.string(),
  type: z.number().int(),
  standardF3o: z.boolean().optional(),
  attribution: z.object({
    reviewer: z.uuid(),
    contractor: z.number().int(),
  }),
});

inquiries.post("/", zValidator("json", inquiryBodySchema), async (c) => {
  const data = c.req.valid("json");
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertCanWrite(u.id, orgId);

  if (data.attribution.reviewer === u.id) {
    throw new ForbiddenError("Reviewer must differ from creator");
  }

  const typeStr = intToEnum("inquiry_type", data.type)!;

  const created = await db.transaction(async (tx) => {
    const [attr] = await tx
      .insert(attribution)
      .values({
        reviewer: data.attribution.reviewer,
        creator: u.id,
        owner: orgId,
        contractor: data.attribution.contractor,
      })
      .returning();

    const [inq] = await tx
      .insert(inquiry)
      .values({
        documentName: data.documentName,
        inspection: data.inspection ?? false,
        jointMeasurement: data.jointMeasurement ?? false,
        floorMeasurement: data.floorMeasurement ?? false,
        note: data.note?.trim() || null,
        documentDate: data.documentDate,
        documentFile: data.documentFile,
        attribution: attr!.id,
        // #973: data owner defaults to the creating org. Once entry moves to a
        // central processing account (Phase 5), this is set to the real owner
        // explicitly while attribution.owner becomes the central account.
        dataOwnerOrganization: orgId,
        accessPolicy: "private",
        type: typeStr,
        standardF3o: data.standardF3o ?? false,
        auditStatus: "todo",
      })
      .returning();
    return inq!;
  });

  const { row, attr } = await loadInquiryScoped(created.id, orgId);
  return c.json(toLegacyInquiry(row, attr));
});

inquiries.put("/:id{[0-9]+}", zValidator("json", inquiryBodySchema), async (c) => {
  const id = parseInt(c.req.param("id"));
  const data = c.req.valid("json");
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertCanWrite(u.id, orgId);

  if (data.attribution.reviewer === u.id) {
    throw new ForbiddenError("Reviewer must differ from creator");
  }

  const typeStr = intToEnum("inquiry_type", data.type)!;
  const { row } = await loadInquiryScoped(id, orgId);

  await db.transaction(async (tx) => {
    await tx
      .update(attribution)
      .set({
        reviewer: data.attribution.reviewer,
        contractor: data.attribution.contractor,
      })
      .where(eq(attribution.id, row.attribution));

    await tx
      .update(inquiry)
      .set({
        documentName: data.documentName,
        inspection: data.inspection ?? false,
        jointMeasurement: data.jointMeasurement ?? false,
        floorMeasurement: data.floorMeasurement ?? false,
        note: data.note?.trim() || null,
        documentDate: data.documentDate,
        documentFile: data.documentFile,
        type: typeStr,
        standardF3o: data.standardF3o ?? false,
        updateDate: new Date(),
      })
      .where(eq(inquiry.id, id));

    // Mirrors C# behavior: an update on a rejected inquiry resets to pending
    // so the writer can resubmit.
    if (row.auditStatus === "rejected") {
      await tx
        .update(inquiry)
        .set({ auditStatus: "pending" })
        .where(eq(inquiry.id, id));
    }
  });

  return c.body(null, 204);
});

inquiries.delete("/:id{[0-9]+}", async (c) => {
  const id = parseInt(c.req.param("id"));
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertCanAdmin(u.id, orgId);

  const { row } = await loadInquiryScoped(id, orgId);

  await db.transaction(async (tx) => {
    await tx.delete(inquirySample).where(eq(inquirySample.inquiry, id));
    await tx.delete(inquiry).where(eq(inquiry.id, id));
    await tx.delete(attribution).where(eq(attribution.id, row.attribution));
  });

  return c.body(null, 204);
});

// ─────────────────────────────────────────────────────────────────────────
// Data owner (#973) — reassign the owning organization of an inquiry's data.
// Admin-gated on the *current* data owner (loadInquiryScoped enforces that the
// caller's org currently owns it); the target org must exist.
// ─────────────────────────────────────────────────────────────────────────

const dataOwnerSchema = z.object({
  dataOwnerOrganizationId: z.uuid(),
});

inquiries.put(
  "/:id{[0-9]+}/data-owner",
  zValidator("json", dataOwnerSchema),
  async (c) => {
    const id = parseInt(c.req.param("id"));
    const { dataOwnerOrganizationId } = c.req.valid("json");
    const u = c.get("user");
    const orgId = activeOrgId(c);
    await assertCanAdmin(u.id, orgId);

    // Caller must currently own the data — scoped load throws 404 otherwise.
    await loadInquiryScoped(id, orgId);

    const [org] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, dataOwnerOrganizationId))
      .limit(1);
    if (!org) throw new ValidationError(["Unknown data owner organization"]);

    await db
      .update(inquiry)
      .set({ dataOwnerOrganization: dataOwnerOrganizationId, updateDate: new Date() })
      .where(eq(inquiry.id, id));

    // Audit trail for the ownership change (no dedicated audit table yet).
    console.info(
      `[audit] inquiry ${id} data_owner ${orgId} -> ${dataOwnerOrganizationId} by user ${u.id}`,
    );

    return c.body(null, 204);
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Status state machine
// ─────────────────────────────────────────────────────────────────────────

inquiries.post("/:id{[0-9]+}/status_review", async (c) => {
  const id = parseInt(c.req.param("id"));
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertCanWrite(u.id, orgId);

  const { row, attr } = await loadInquiryScoped(id, orgId);
  const next = transitionStatus(row.auditStatus, "pending_review");
  await db.update(inquiry).set({ auditStatus: next }).where(eq(inquiry.id, id));

  await sendReviewRequestedEmail(await emailContext({ ...row, auditStatus: next }, attr));
  return c.body(null, 204);
});

const statusChangeSchema = z.object({
  message: z.string().min(1),
});

inquiries.post(
  "/:id{[0-9]+}/status_rejected",
  zValidator("json", statusChangeSchema),
  async (c) => {
    const id = parseInt(c.req.param("id"));
    const { message } = c.req.valid("json");
    const u = c.get("user");
    const orgId = activeOrgId(c);
    await assertCanReview(u.id, orgId);

    const { row, attr } = await loadInquiryScoped(id, orgId);
    const next = transitionStatus(row.auditStatus, "rejected");
    await db.update(inquiry).set({ auditStatus: next }).where(eq(inquiry.id, id));

    await sendRejectedEmail({
      ...(await emailContext({ ...row, auditStatus: next }, attr)),
      motivation: message,
    });
    return c.body(null, 204);
  },
);

inquiries.post("/:id{[0-9]+}/status_approved", async (c) => {
  const id = parseInt(c.req.param("id"));
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertCanReview(u.id, orgId);

  const { row, attr } = await loadInquiryScoped(id, orgId);
  const next = transitionStatus(row.auditStatus, "done");
  await db.update(inquiry).set({ auditStatus: next }).where(eq(inquiry.id, id));

  await sendApprovedEmail(await emailContext({ ...row, auditStatus: next }, attr));
  return c.body(null, 204);
});

inquiries.post("/:id{[0-9]+}/reset", async (c) => {
  const id = parseInt(c.req.param("id"));
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertCanWrite(u.id, orgId);

  const { row } = await loadInquiryScoped(id, orgId);
  // C# uses TransitionToPending which is unconditional.
  await db
    .update(inquiry)
    .set({ auditStatus: "pending" })
    .where(eq(inquiry.id, id));
  void row;
  return c.body(null, 204);
});

export default inquiries;

// Re-exports for sample sub-router.
export {
  loadInquiryScoped,
  requireWritable,
  activeOrgId,
};
