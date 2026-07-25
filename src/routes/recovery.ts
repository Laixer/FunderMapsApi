import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import {
  eq,
  and,
  count,
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
import { recovery, recoverySample } from "../db/schema/report.ts";
import {
  handleDocumentUpload,
  markFileResource,
} from "../lib/upload-handler.ts";
import { assertOrgPermission, isPlatformMember } from "../lib/auth-helpers.ts";
import { intToEnum } from "../lib/inquiry-enums.ts";
import {
  toLegacyRecovery,
} from "../lib/recovery-serializer.ts";
import type { AttributionView } from "../lib/inquiry-serializer.ts";
import { describeDocumentFile } from "../lib/document-file.ts";
import {
  type RecoveryEmailContext,
  sendApprovedEmail,
  sendRejectedEmail,
  sendReviewRequestedEmail,
} from "../lib/recovery-emails.ts";
import { recordEvent, listEvents } from "../lib/dossier-events.ts";
import { NotFoundError, ForbiddenError, ValidationError } from "../lib/errors.ts";
import type { AppEnv, AuthUser } from "../types/context.ts";

const recoveries = new Hono<AppEnv>();

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

function recoverySelector() {
  return db
    .select({
      recovery,
      attr: {
        reviewer: attribution.reviewer,
        reviewerName: reviewerU.email,
        creator: attribution.creator,
        creatorName: creatorU.email,
        owner: attribution.owner,
        ownerName: organization.name,
        dataOwner: recovery.dataOwnerOrganization,
        dataOwnerName: dataOwnerOrg.name,
        contractor: attribution.contractor,
        contractorName: contractor.name,
      },
    })
    .from(recovery)
    .innerJoin(attribution, eq(attribution.id, recovery.attribution))
    .innerJoin(reviewerU, eq(reviewerU.id, attribution.reviewer))
    .innerJoin(creatorU, eq(creatorU.id, attribution.creator))
    .innerJoin(organization, eq(organization.id, attribution.owner))
    .leftJoin(dataOwnerOrg, eq(dataOwnerOrg.id, recovery.dataOwnerOrganization))
    .innerJoin(contractor, eq(contractor.id, attribution.contractor));
}

async function loadRecoveryScoped(
  id: number,
  orgIds: string[] | null,
): Promise<{ row: typeof recovery.$inferSelect; attr: AttributionView }> {
  const [hit] = await recoverySelector()
    .where(
      and(
        eq(recovery.id, id),
        orgIds === null
          ? undefined
          : inArray(recovery.dataOwnerOrganization, orgIds),
      ),
    )
    .limit(1);
  if (!hit) throw new NotFoundError("Recovery not found");
  return { row: hit.recovery, attr: hit.attr };
}

// Ownership-agnostic lookup (issue #968): recovery source files are downloadable
// by any logged-in user, not just the owning organization.
async function loadRecoveryUnscoped(
  id: number,
): Promise<{ row: typeof recovery.$inferSelect; attr: AttributionView }> {
  const [hit] = await recoverySelector().where(eq(recovery.id, id)).limit(1);
  if (!hit) throw new NotFoundError("Recovery not found");
  return { row: hit.recovery, attr: hit.attr };
}

function requireWritable(row: typeof recovery.$inferSelect) {
  const allowed = ["todo", "pending", "rejected"];
  if (!row.auditStatus || !allowed.includes(row.auditStatus)) {
    throw new ForbiddenError(
      `Recovery is read-only in state '${row.auditStatus}'`,
    );
  }
}

function transitionStatus(
  current: string | null,
  target: "pending" | "pending_review" | "done" | "rejected" | "todo",
): string {
  const cur = current ?? "todo";
  const allowed: Record<typeof target, string[]> = {
    pending: [],
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
  rec: typeof recovery.$inferSelect,
  attr: AttributionView,
): Promise<RecoveryEmailContext> {
  // Stub helper kept for future Mailgun wiring; current emails are no-ops.
  return {
    recoveryId: rec.id,
    documentName: rec.documentName,
    creatorEmail: attr.creatorName ?? "",
    creatorName: attr.creatorName ?? "",
    reviewerEmail: attr.reviewerName ?? "",
    reviewerName: attr.reviewerName ?? "",
    organizationName: attr.ownerName ?? "",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Literal routes (must register before /:id-style)
// ─────────────────────────────────────────────────────────────────────────

recoveries.post("/upload-document", async (c) => {
  const result = await handleDocumentUpload(c, "recovery-report");
  return c.json(result);
});

// ─────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────

recoveries.get("/stats", async (c) => {
  const scope = dataScope(c);
  const [stat] = await db
    .select({ value: count() })
    .from(recovery)
    .innerJoin(attribution, eq(attribution.id, recovery.attribution))
    .where(
      scope === null
        ? undefined
        : inArray(recovery.dataOwnerOrganization, scope),
    );
  return c.json({ count: Number(stat?.value ?? 0) });
});

recoveries.get("/building/:bid", async (c) => {
  const scope = dataScope(c);
  const buildingId = c.req.param("bid");
  const limit = parseInt(c.req.query("limit") ?? "100");
  const offset = parseInt(c.req.query("offset") ?? "0");

  const rows = await recoverySelector()
    .innerJoin(recoverySample, eq(recoverySample.recovery, recovery.id))
    .where(
      and(
        eq(recoverySample.buildingId, buildingId),
        scope === null
          ? undefined
          : inArray(recovery.dataOwnerOrganization, scope),
      ),
    )
    .groupBy(
      recovery.id,
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
    .orderBy(sql`coalesce(${recovery.updateDate}, ${recovery.createDate}) DESC`)
    .limit(limit)
    .offset(offset);

  return c.json(rows.map((r) => toLegacyRecovery(r.recovery, r.attr)));
});

recoveries.get("/", async (c) => {
  const scope = dataScope(c);
  const q = c.req.query("q")?.trim();
  const defaultLimit = q ? 500 : 100;
  const limit = parseInt(c.req.query("limit") ?? String(defaultLimit));
  const offset = parseInt(c.req.query("offset") ?? "0");

  const where: SQL[] = [];
  if (scope !== null)
    where.push(inArray(recovery.dataOwnerOrganization, scope));
  if (q) where.push(buildRecoverySearchPredicate(q));

  const rows = await recoverySelector()
    .where(and(...where))
    .orderBy(sql`coalesce(${recovery.updateDate}, ${recovery.createDate}) DESC`)
    .limit(limit)
    .offset(offset);

  return c.json(rows.map((r) => toLegacyRecovery(r.recovery, r.attr)));
});

// Recovery samples only carry a building_id (BAG PAND), not an address row,
// so the search surface is narrower than inquiry's.
function buildRecoverySearchPredicate(q: string): SQL {
  // BAG identifiers contain long digit runs (e.g. "0202100000216966") that
  // overflow int32 — only treat as an ID match when it fits.
  const asInt = /^\d+$/.test(q) ? Number(q) : NaN;
  const numericId = Number.isSafeInteger(asInt) && asInt <= 2147483647 ? asInt : null;

  // Fast path — see inquiry.ts for the perf rationale.
  if (numericId != null) {
    return eq(recovery.id, numericId);
  }

  const like = `%${q}%`;
  const sampleMatch = exists(
    db
      .select({ x: sql`1` })
      .from(recoverySample)
      .where(
        and(
          eq(recoverySample.recovery, recovery.id),
          ilike(recoverySample.buildingId, like),
        ),
      ),
  );

  return or(ilike(recovery.documentName, like), sampleMatch)!;
}

recoveries.get("/:id{[0-9]+}", async (c) => {
  const id = parseInt(c.req.param("id"));
  const { row, attr } = await loadRecoveryScoped(id, dataScope(c));
  return c.json(toLegacyRecovery(row, attr));
});

// `accessLink` is unchanged; the rest is additive. See lib/document-file.ts.
recoveries.get("/:id{[0-9]+}/download", async (c) => {
  const id = parseInt(c.req.param("id"));
  const { row } = await loadRecoveryUnscoped(id);
  return c.json(await describeDocumentFile("recovery-report", row.documentFile));
});

// ─────────────────────────────────────────────────────────────────────────
// Writes — body shape mirrors what ClientApp sends (camelCase, nested
// attribution, integer enums)
// ─────────────────────────────────────────────────────────────────────────

const recoveryBodySchema = z.object({
  documentName: z.string().min(1),
  note: z.string().nullish(),
  documentDate: z.string(),
  documentFile: z.string(),
  type: z.number().int(),
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
    await assertOrgPermission(u.id, orgId, "recovery", "assign-owner");
  }
  const [org] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, requested))
    .limit(1);
  if (!org) throw new ValidationError(["Unknown data owner organization"]);
  return requested;
}

recoveries.post("/", zValidator("json", recoveryBodySchema), async (c) => {
  const data = c.req.valid("json");
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertOrgPermission(u.id, orgId, "recovery", "write");

  if (data.attribution.reviewer === u.id) {
    throw new ForbiddenError("Reviewer must differ from creator");
  }

  const typeStr = intToEnum("recovery_document_type", data.type)!;
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

    const [rec] = await tx
      .insert(recovery)
      .values({
        documentName: data.documentName,
        note: data.note?.trim() || null,
        documentDate: data.documentDate,
        documentFile: data.documentFile,
        attribution: attr!.id,
        // #973: data owner — defaults to creating org or an admin-assigned org.
        dataOwnerOrganization: dataOwner,
        accessPolicy: "private",
        type: typeStr,
        auditStatus: "todo",
      })
      .returning();
    await recordEvent({ recovery: rec!.id }, "created", { actor: u.id }, tx);
    return rec!;
  });

  await markFileResource(`recovery-report/${data.documentFile}`, "active");

  // Scope the reload to the data owner (may differ from the caller's org).
  const { row, attr } = await loadRecoveryScoped(created.id, [dataOwner]);
  return c.json(toLegacyRecovery(row, attr));
});

recoveries.put("/:id{[0-9]+}", zValidator("json", recoveryBodySchema), async (c) => {
  const id = parseInt(c.req.param("id"));
  const data = c.req.valid("json");
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertOrgPermission(u.id, orgId, "recovery", "write");

  if (data.attribution.reviewer === u.id) {
    throw new ForbiddenError("Reviewer must differ from creator");
  }

  const typeStr = intToEnum("recovery_document_type", data.type)!;
  const { row } = await loadRecoveryScoped(id, dataScope(c));

  await db.transaction(async (tx) => {
    await tx
      .update(attribution)
      .set({
        reviewer: data.attribution.reviewer,
        contractor: data.attribution.contractor,
      })
      .where(eq(attribution.id, row.attribution));

    await tx
      .update(recovery)
      .set({
        documentName: data.documentName,
        note: data.note?.trim() || null,
        documentDate: data.documentDate,
        documentFile: data.documentFile,
        type: typeStr,
        updateDate: new Date(),
      })
      .where(eq(recovery.id, id));

    if (row.auditStatus === "rejected") {
      await tx
        .update(recovery)
        .set({ auditStatus: "pending" })
        .where(eq(recovery.id, id));
    }
  });

  await markFileResource(`recovery-report/${data.documentFile}`, "active");
  if (row.documentFile !== data.documentFile) {
    await markFileResource(`recovery-report/${row.documentFile}`, "archived");
  }

  return c.body(null, 204);
});

recoveries.delete("/:id{[0-9]+}", async (c) => {
  const id = parseInt(c.req.param("id"));
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertOrgPermission(u.id, orgId, "recovery", "delete");

  const { row } = await loadRecoveryScoped(id, dataScope(c));

  await db.transaction(async (tx) => {
    await tx.delete(recoverySample).where(eq(recoverySample.recovery, id));
    await tx.delete(recovery).where(eq(recovery.id, id));
    await tx.delete(attribution).where(eq(attribution.id, row.attribution));
  });

  await markFileResource(`recovery-report/${row.documentFile}`, "archived");

  return c.body(null, 204);
});

// ─────────────────────────────────────────────────────────────────────────
// Data owner (#973) — reassign the owning organization of a recovery's data.
// Admin-gated on the *current* data owner; the target org must exist.
// ─────────────────────────────────────────────────────────────────────────

const dataOwnerSchema = z.object({
  dataOwnerOrganizationId: z.uuid(),
});

recoveries.put(
  "/:id{[0-9]+}/data-owner",
  zValidator("json", dataOwnerSchema),
  async (c) => {
    const id = parseInt(c.req.param("id"));
    const { dataOwnerOrganizationId } = c.req.valid("json");
    const u = c.get("user");
    const orgId = activeOrgId(c);
    await assertOrgPermission(u.id, orgId, "recovery", "assign-owner");

    // Caller must currently own the data (platform staff: any org) — scoped
    // load throws 404 otherwise.
    const { row } = await loadRecoveryScoped(id, dataScope(c));

    const [org] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, dataOwnerOrganizationId))
      .limit(1);
    if (!org) throw new ValidationError(["Unknown data owner organization"]);

    await db
      .update(recovery)
      .set({ dataOwnerOrganization: dataOwnerOrganizationId, updateDate: new Date() })
      .where(eq(recovery.id, id));

    console.info(
      `[audit] recovery ${id} data_owner ${row.dataOwnerOrganization} -> ${dataOwnerOrganizationId} by user ${u.id}`,
    );

    return c.body(null, 204);
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Status state machine
// ─────────────────────────────────────────────────────────────────────────

recoveries.post("/:id{[0-9]+}/status_review", async (c) => {
  const id = parseInt(c.req.param("id"));
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertOrgPermission(u.id, orgId, "recovery", "write");

  const { row, attr } = await loadRecoveryScoped(id, dataScope(c));
  const next = transitionStatus(row.auditStatus, "pending_review");
  // Status change and trail entry commit together — a trail that can silently
  // miss entries reads as authoritative while being wrong.
  await db.transaction(async (tx) => {
    await tx.update(recovery).set({ auditStatus: next }).where(eq(recovery.id, id));
    await recordEvent({ recovery: id }, "submitted", { actor: u.id }, tx);
  });

  await sendReviewRequestedEmail(await emailContext({ ...row, auditStatus: next }, attr));
  return c.body(null, 204);
});

const statusChangeSchema = z.object({
  message: z.string().min(1),
});

recoveries.post(
  "/:id{[0-9]+}/status_rejected",
  zValidator("json", statusChangeSchema),
  async (c) => {
    const id = parseInt(c.req.param("id"));
    const { message } = c.req.valid("json");
    const u = c.get("user");
    const orgId = activeOrgId(c);
    await assertOrgPermission(u.id, orgId, "recovery", "review");

    const { row, attr } = await loadRecoveryScoped(id, dataScope(c));
    const next = transitionStatus(row.auditStatus, "rejected");
    await db.transaction(async (tx) => {
      await tx.update(recovery).set({ auditStatus: next }).where(eq(recovery.id, id));
      // The motivation was previously handed to Mailgun and stored nowhere.
      await recordEvent({ recovery: id }, "rejected", { actor: u.id, note: message }, tx);
    });

    await sendRejectedEmail({
      ...(await emailContext({ ...row, auditStatus: next }, attr)),
      motivation: message,
    });
    return c.body(null, 204);
  },
);

recoveries.post("/:id{[0-9]+}/status_approved", async (c) => {
  const id = parseInt(c.req.param("id"));
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertOrgPermission(u.id, orgId, "recovery", "review");

  const { row, attr } = await loadRecoveryScoped(id, dataScope(c));
  const next = transitionStatus(row.auditStatus, "done");
  await db.transaction(async (tx) => {
    await tx.update(recovery).set({ auditStatus: next }).where(eq(recovery.id, id));
    await recordEvent({ recovery: id }, "approved", { actor: u.id }, tx);
  });

  await sendApprovedEmail(await emailContext({ ...row, auditStatus: next }, attr));
  return c.body(null, 204);
});

recoveries.post("/:id{[0-9]+}/reset", async (c) => {
  const id = parseInt(c.req.param("id"));
  const u = c.get("user");
  const orgId = activeOrgId(c);
  await assertOrgPermission(u.id, orgId, "recovery", "write");

  const { row } = await loadRecoveryScoped(id, dataScope(c));
  await db.transaction(async (tx) => {
    await tx
      .update(recovery)
      .set({ auditStatus: "pending" })
      .where(eq(recovery.id, id));
    // Which state it was pulled back out of: reopening an approved dossier is a
    // very different act from reopening a rejected one.
    await recordEvent(
      { recovery: id },
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
 * Scoped through `loadRecoveryScoped` so it inherits the same org/data-owner
 * check as reading the dossier itself — the trail names people and carries
 * rejection motivations, so it is no less sensitive than the record.
 */
recoveries.get("/:id{[0-9]+}/events", async (c) => {
  const id = parseInt(c.req.param("id"));
  await loadRecoveryScoped(id, dataScope(c));
  return c.json(await listEvents({ recovery: id }));
});

export default recoveries;

export {
  loadRecoveryScoped,
  requireWritable,
  activeOrgId,
  dataScope,
};
