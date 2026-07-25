import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import {
  eq,
  and,
  asc,
  count,
  desc,
  exists,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
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
import {
  handleDocumentUpload,
  markFileResource,
} from "../lib/upload-handler.ts";
import { assertOrgPermission, isPlatformMember } from "../lib/auth-helpers.ts";
import { intToEnum } from "../lib/inquiry-enums.ts";
import {
  toLegacyInquiry,
  type AttributionView,
} from "../lib/inquiry-serializer.ts";
import { describeDocumentFile } from "../lib/document-file.ts";
import { recordEvent, listEvents } from "../lib/dossier-events.ts";
import { NotFoundError, ForbiddenError, ValidationError } from "../lib/errors.ts";
import {
  sendApprovedEmail,
  sendRejectedEmail,
  sendReviewRequestedEmail,
  type InquiryEmailContext,
} from "../lib/inquiry-emails.ts";
import type { AppEnv, AuthUser } from "../types/context.ts";

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

// Org scope for data access: FunderMaps staff (platform-org members) work
// across all organizations, so their scope is null — no data-owner filter.
// Everyone else sees data owned by ANY org they belong to.
function dataScope(c: Context<AppEnv>): string[] | null {
  const u = c.get("user");
  if (isPlatformMember(u)) return null;
  const ids = u.organizations.map((o) => o.id);
  if (ids.length === 0) {
    throw new ForbiddenError("User is not a member of any organization");
  }
  return ids;
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
  orgIds: string[] | null,
): Promise<{ row: typeof inquiry.$inferSelect; attr: AttributionView }> {
  const [hit] = await inquirySelector()
    .where(
      and(
        eq(inquiry.id, id),
        orgIds === null
          ? undefined
          : inArray(inquiry.dataOwnerOrganization, orgIds),
      ),
    )
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
  const scope = dataScope(c);
  const [stat] = await db
    .select({ value: count() })
    .from(inquiry)
    .innerJoin(attribution, eq(attribution.id, inquiry.attribution))
    .where(
      scope === null
        ? undefined
        : inArray(inquiry.dataOwnerOrganization, scope),
    );
  return c.json({ count: Number(stat?.value ?? 0) });
});

inquiries.get("/building/:bid", async (c) => {
  const scope = dataScope(c);
  const buildingId = c.req.param("bid");
  const limit = parseInt(c.req.query("limit") ?? "100");
  const offset = parseInt(c.req.query("offset") ?? "0");

  const rows = await inquirySelector()
    .innerJoin(inquirySample, eq(inquirySample.inquiry, inquiry.id))
    .where(
      and(
        eq(inquirySample.building, buildingId),
        scope === null
          ? undefined
          : inArray(inquiry.dataOwnerOrganization, scope),
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

// Sortable columns for the list endpoint. Sorting by creator/reviewer sorts
// on the joined user email — the same string the clients display.
const LIST_SORT_COLUMNS = {
  id: inquiry.id,
  document_name: inquiry.documentName,
  type: inquiry.type,
  document_date: inquiry.documentDate,
  creator: creatorU.email,
  reviewer: reviewerU.email,
  status: inquiry.auditStatus,
} as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

inquiries.get("/", async (c) => {
  const scope = dataScope(c);
  const q = c.req.query("q")?.trim();
  // When searching, default to a larger ceiling so the staff actually see
  // their matches; bare browse stays at 100. Caller can still override.
  const defaultLimit = q ? 500 : 100;
  const limit = parseInt(c.req.query("limit") ?? String(defaultLimit));
  const offset = parseInt(c.req.query("offset") ?? "0");

  const where: SQL[] = [];
  if (scope !== null)
    where.push(inArray(inquiry.dataOwnerOrganization, scope));
  if (q) where.push(buildInquirySearchPredicate(q));

  // Column filters (ClientApp #263, item 8). `status` takes wire-format
  // integers, comma-separated; `creator`/`reviewer` take a user id.
  const statusParam = c.req.query("status");
  if (statusParam) {
    let statuses: string[];
    try {
      statuses = statusParam
        .split(",")
        .map((s) => intToEnum("audit_status", parseInt(s.trim(), 10))!);
    } catch {
      throw new ValidationError([`Invalid status filter: ${statusParam}`]);
    }
    where.push(inArray(inquiry.auditStatus, statuses));
  }
  for (const [param, column] of [
    ["creator", attribution.creator],
    ["reviewer", attribution.reviewer],
  ] as const) {
    const value = c.req.query(param);
    if (!value) continue;
    if (!UUID_RE.test(value)) {
      throw new ValidationError([`Invalid ${param} filter: expected a user id`]);
    }
    where.push(eq(column, value));
  }

  const sortParam = c.req.query("sort");
  if (sortParam && !(sortParam in LIST_SORT_COLUMNS)) {
    throw new ValidationError([`Invalid sort column: ${sortParam}`]);
  }
  const sortColumn = sortParam
    ? LIST_SORT_COLUMNS[sortParam as keyof typeof LIST_SORT_COLUMNS]
    : null;
  const orderBy = sortColumn
    ? c.req.query("order") === "asc"
      ? asc(sortColumn)
      : desc(sortColumn)
    : sql`coalesce(${inquiry.updateDate}, ${inquiry.createDate}) DESC`;

  const rows = await inquirySelector()
    .where(and(...where))
    .orderBy(orderBy)
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
  const { row, attr } = await loadInquiryScoped(id, dataScope(c));
  return c.json(toLegacyInquiry(row, attr));
});

// `accessLink` is unchanged; the rest is additive, so existing callers are
// unaffected. See lib/document-file.ts for why the name has to be looked up.
inquiries.get("/:id{[0-9]+}/download", async (c) => {
  const id = parseInt(c.req.param("id"));
  const { row } = await loadInquiryUnscoped(id);
  return c.json(await describeDocumentFile("inquiry-report", row.documentFile));
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
  // #973: optionally assign the data to another organization (central-account
  // entry workflow). Admin-gated; defaults to the creating org when omitted.
  dataOwnerOrganizationId: z.uuid().optional(),
  attribution: z.object({
    reviewer: z.uuid(),
    contractor: z.number().int(),
  }),
});

// Resolve the data-owner org for a create: defaults to the caller's org, but
// platform staff (any writer) or an org admin may assign it to another
// (existing) organization. Returns the org id.
async function resolveDataOwner(
  u: AuthUser,
  orgId: string,
  requested: string | undefined,
): Promise<string> {
  if (!requested || requested === orgId) return orgId;
  // Assigning customer orgs is the staff's normal invoer flow; outside the
  // platform org it stays admin-gated.
  if (!isPlatformMember(u)) {
    await assertOrgPermission(u.id, orgId, "inquiry", "assign-owner");
  }
  const [org] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, requested))
    .limit(1);
  if (!org) throw new ValidationError(["Unknown data owner organization"]);
  return requested;
}

inquiries.post("/", zValidator("json", inquiryBodySchema), async (c) => {
  const data = c.req.valid("json");
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  if (data.attribution.reviewer === u.id) {
    throw new ForbiddenError("Reviewer must differ from creator");
  }

  const typeStr = intToEnum("inquiry_type", data.type)!;
  const dataOwner = await resolveDataOwner(u, orgId, data.dataOwnerOrganizationId);

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
        // #973: data owner — defaults to the creating org, or the org an admin
        // assigned via dataOwnerOrganizationId (central-account entry workflow).
        dataOwnerOrganization: dataOwner,
        accessPolicy: "private",
        type: typeStr,
        standardF3o: data.standardF3o ?? false,
        auditStatus: "todo",
      })
      .returning();
    await recordEvent({ inquiry: inq!.id }, "created", { actor: u.id }, tx);
    return inq!;
  });

  await markFileResource(`inquiry-report/${data.documentFile}`, "active");

  // Scope the reload to the data owner (may differ from the caller's org).
  const { row, attr } = await loadInquiryScoped(created.id, [dataOwner]);
  return c.json(toLegacyInquiry(row, attr));
});

inquiries.put("/:id{[0-9]+}", zValidator("json", inquiryBodySchema), async (c) => {
  const id = parseInt(c.req.param("id"));
  const data = c.req.valid("json");
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  if (data.attribution.reviewer === u.id) {
    throw new ForbiddenError("Reviewer must differ from creator");
  }

  const typeStr = intToEnum("inquiry_type", data.type)!;
  const { row } = await loadInquiryScoped(id, dataScope(c));

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

  await markFileResource(`inquiry-report/${data.documentFile}`, "active");
  if (row.documentFile !== data.documentFile) {
    await markFileResource(`inquiry-report/${row.documentFile}`, "archived");
  }

  return c.body(null, 204);
});

inquiries.delete("/:id{[0-9]+}", async (c) => {
  const id = parseInt(c.req.param("id"));
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertOrgPermission(u.id, orgId, "inquiry", "delete");

  const { row } = await loadInquiryScoped(id, dataScope(c));

  await db.transaction(async (tx) => {
    await tx.delete(inquirySample).where(eq(inquirySample.inquiry, id));
    await tx.delete(inquiry).where(eq(inquiry.id, id));
    await tx.delete(attribution).where(eq(attribution.id, row.attribution));
  });

  await markFileResource(`inquiry-report/${row.documentFile}`, "archived");

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
    await assertOrgPermission(u.id, orgId, "inquiry", "assign-owner");

    // Caller must currently own the data (platform staff: any org) — scoped
    // load throws 404 otherwise.
    const { row } = await loadInquiryScoped(id, dataScope(c));

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
      `[audit] inquiry ${id} data_owner ${row.dataOwnerOrganization} -> ${dataOwnerOrganizationId} by user ${u.id}`,
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
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  const { row, attr } = await loadInquiryScoped(id, dataScope(c));
  const next = transitionStatus(row.auditStatus, "pending_review");
  // Status change and trail entry commit together — a trail that can silently
  // miss entries reads as authoritative while being wrong.
  await db.transaction(async (tx) => {
    await tx.update(inquiry).set({ auditStatus: next }).where(eq(inquiry.id, id));
    await recordEvent({ inquiry: id }, "submitted", { actor: u.id }, tx);
  });

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
    await assertOrgPermission(u.id, orgId, "inquiry", "review");

    const { row, attr } = await loadInquiryScoped(id, dataScope(c));
    const next = transitionStatus(row.auditStatus, "rejected");
    await db.transaction(async (tx) => {
      await tx.update(inquiry).set({ auditStatus: next }).where(eq(inquiry.id, id));
      // The motivation was previously handed to Mailgun and stored nowhere, so
      // the person who has to fix the report could only learn why from their
      // inbox — one api-prod without MAILGUN_* envs away from nowhere at all.
      await recordEvent({ inquiry: id }, "rejected", { actor: u.id, note: message }, tx);
    });

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
  await assertOrgPermission(u.id, orgId, "inquiry", "review");

  const { row, attr } = await loadInquiryScoped(id, dataScope(c));
  const next = transitionStatus(row.auditStatus, "done");
  await db.transaction(async (tx) => {
    await tx.update(inquiry).set({ auditStatus: next }).where(eq(inquiry.id, id));
    await recordEvent({ inquiry: id }, "approved", { actor: u.id }, tx);
  });

  await sendApprovedEmail(await emailContext({ ...row, auditStatus: next }, attr));
  return c.body(null, 204);
});

inquiries.post("/:id{[0-9]+}/reset", async (c) => {
  const id = parseInt(c.req.param("id"));
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  const { row } = await loadInquiryScoped(id, dataScope(c));
  // C# uses TransitionToPending which is unconditional.
  await db.transaction(async (tx) => {
    await tx
      .update(inquiry)
      .set({ auditStatus: "pending" })
      .where(eq(inquiry.id, id));
    // Worth recording which state it was pulled back out of: reopening an
    // approved dossier is a very different act from reopening a rejected one.
    await recordEvent(
      { inquiry: id },
      "reopened",
      { actor: u.id, metadata: { from: row.auditStatus } },
      tx,
    );
  });
  return c.body(null, 204);
});

/**
 * The dossier's trail, oldest first.
 *
 * Scoped through `loadInquiryScoped` so it inherits the same org/data-owner
 * check as reading the dossier itself — the trail names people and carries
 * rejection motivations, so it is no less sensitive than the record.
 */
inquiries.get("/:id{[0-9]+}/events", async (c) => {
  const id = parseInt(c.req.param("id"));
  await loadInquiryScoped(id, dataScope(c));
  return c.json(await listEvents({ inquiry: id }));
});

export default inquiries;

// Re-exports for sample sub-router.
export {
  loadInquiryScoped,
  requireWritable,
  activeOrgId,
  dataScope,
};
