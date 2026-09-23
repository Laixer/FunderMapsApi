import { Hono } from "hono";
import { asc, eq, inArray } from "drizzle-orm";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../db/client.ts";
import { dossier, artifact } from "../db/schema/dataops.ts";
import { recovery, recoverySample } from "../db/schema/report.ts";
import { attribution, contractor as contractorTable, fileResource, user as userTable } from "../db/schema/application.ts";
import { address as geocoderAddress, building as geocoderBuilding } from "../db/schema/geocoder.ts";
import { s3Client } from "../lib/s3.ts";
import { env } from "../config.ts";
import { recordEvent } from "../lib/dossier-events.ts";
import { addEntry } from "../lib/dossier-entries.ts";
import { assertOrgPermission } from "../lib/auth-helpers.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.ts";
import { validateRecoveryBody, type RecoveryBody, type RecoverySampleInput } from "../lib/recovery-body.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * Herstel vastleggen (Studio #341).
 *
 * A melding "Doorgeven herstelmaatregelen" comes with a herstel drawing or an
 * oplevering. The rapportage commit (dataops-commit.ts) cannot say "this pand
 * was repaired", so until now the reviewer typed the herstel into the Studio by
 * hand and the dossier, the document and report.recovery never met.
 *
 * This writes the same rows the Studio's herstel form does -- one attribution,
 * one report.recovery, one report.recovery_sample per pand -- with the dossier's
 * document copied into recovery-report/ as its document, the dossier id in
 * each sample's metadata, and dataops.dossier.recovery_id pointing back.
 *
 * The pipeline does not read herstel fields (type, status, pile type, dates),
 * so the reviewer gives them here; the melder's own "Soort herstel" is a hint
 * in the Studio, never trusted as a value.
 *
 * It does NOT close the dossier. A herstel drawing usually also shows the
 * original foundation type, which is rapportage material; the reviewer closes
 * the dossier afterwards, with or without a rapportage. A dossier can
 * therefore carry both inquiry_id and recovery_id.
 */
const dataopsRecovery = new Hono<AppEnv>();

const SERVICE_USER_EMAIL = "dataops@fundermaps.com";
/** application.contractor 10 = FunderMaps B.V., the fallback the rapportage commit uses too. */
const CONTRACTOR_FUNDERMAPS = 10;

/** Pand ids for the given inputs; unknown ids are reported, never guessed. */
async function resolvePanden(inputs: string[]): Promise<{ byInput: Map<string, string>; unknown: string[] }> {
  const byInput = new Map<string, string>();
  const addressIds = inputs.filter((i) => i.toUpperCase().startsWith("NL.IMBAG.NUMMERAANDUIDING."));
  const pandIds = inputs.filter((i) => i.toUpperCase().startsWith("NL.IMBAG.PAND."));
  if (addressIds.length) {
    const rows = await db.select({ id: geocoderAddress.externalId, building: geocoderAddress.buildingId }).from(geocoderAddress).where(inArray(geocoderAddress.externalId, addressIds));
    for (const r of rows) if (r.building) byInput.set(r.id, r.building);
  }
  if (pandIds.length) {
    const rows = await db.select({ id: geocoderBuilding.external_id }).from(geocoderBuilding).where(inArray(geocoderBuilding.external_id, pandIds));
    for (const r of rows) byInput.set(r.id, r.id);
  }
  return { byInput, unknown: inputs.filter((i) => !byInput.has(i)) };
}

dataopsRecovery.post("/dossier/:id/recovery", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const u = c.get("user");
  const orgId = u.organizations[0]?.id;
  if (!orgId) throw new ForbiddenError("User is not a member of any organization");
  await assertOrgPermission(u.id, orgId, "recovery", "write");

  const body = await c.req.json<Partial<RecoveryBody>>().catch(() => ({}) as Partial<RecoveryBody>);
  const errors = validateRecoveryBody(body);
  if (errors.length) throw new ValidationError(errors);
  const input = body as RecoveryBody;

  const [head] = await db.select().from(dossier).where(eq(dossier.id, id)).limit(1);
  if (!head) throw new NotFoundError("dossier not found");
  if (head.recoveryId) throw new ValidationError([`dossier already recorded herstel ${head.recoveryId}`]);
  if (head.outcome) throw new ValidationError(["dossier is closed; reopen it before recording a herstel"]);

  const [svc] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, SERVICE_USER_EMAIL)).limit(1);
  if (!svc) throw new ValidationError([`service user ${SERVICE_USER_EMAIL} is missing`]);

  const artifacts = await db.select().from(artifact).where(eq(artifact.dossierId, id)).orderBy(asc(artifact.id));
  const document = artifacts.find((a) => a.storageKey.startsWith("dataops/") || a.storageKey.startsWith("intake/"));
  if (!document) throw new ValidationError(["dossier has no document to record the herstel with"]);

  const { byInput, unknown } = await resolvePanden([...new Set(input.samples.map((s) => s.building))]);
  if (unknown.length) throw new ValidationError(unknown.map((b) => `unknown pand or address: ${b}`));
  // One sample per pand: two addresses of one building are one herstel.
  const perPand = new Map<string, RecoverySampleInput>();
  for (const s of input.samples) {
    const pand = byInput.get(s.building)!;
    if (!perPand.has(pand)) perPand.set(pand, s);
  }

  let contractorId = CONTRACTOR_FUNDERMAPS;
  if (input.contractor != null) {
    const [row] = await db.select({ id: contractorTable.id }).from(contractorTable).where(eq(contractorTable.id, input.contractor)).limit(1);
    if (!row) throw new ValidationError([`unknown contractor: ${input.contractor}`]);
    contractorId = row.id;
  }

  // The herstel record gets its own copy, in the folder the Studio's herstel
  // download reads (describeDocumentFile("recovery-report", …)).
  const ext = (document.storageKey.split(".").pop() ?? "pdf").toLowerCase();
  const fileName = `${crypto.randomUUID()}.${ext}`;
  const targetKey = `recovery-report/${fileName}`;
  await s3Client().send(new CopyObjectCommand({
    Bucket: env.S3_BUCKET!,
    CopySource: `${env.S3_BUCKET!}/${document.storageKey}`,
    Key: targetKey,
    MetadataDirective: "COPY",
  }));

  const documentName = document.originalFilename?.replace(/^[0-9a-f]{16}-/, "") ?? `dossier-${id}`;
  const note = [input.note?.trim(), head.subject ? `Dossier: ${head.subject}` : null, head.reference ? `Meldcode ${head.reference}` : null]
    .filter(Boolean)
    .join("\n");
  // A herstel whose type nobody could name is not done: someone fills it in.
  const auditStatus = [...perPand.values()].every((s) => s.type !== "unknown") ? "done" : "pending";

  const created = await db.transaction(async (tx) => {
    await tx.insert(fileResource).values({
      key: targetKey,
      originalFilename: document.originalFilename ?? fileName,
      status: "active",
      sizeBytes: document.sizeBytes,
      mimeType: document.mimeType ?? (ext === "pdf" ? "application/pdf" : `image/${ext === "jpg" ? "jpeg" : ext}`),
    });
    const [attr] = await tx
      .insert(attribution)
      .values({ reviewer: u.id, creator: svc.id, owner: orgId, contractor: contractorId })
      .returning();
    const [rec] = await tx
      .insert(recovery)
      .values({
        note: note || null,
        attribution: attr!.id,
        dataOwnerOrganization: orgId,
        accessPolicy: "private",
        type: input.documentType,
        documentDate: input.documentDate,
        documentFile: fileName,
        documentName,
        auditStatus,
      })
      .returning({ id: recovery.id });
    for (const [pand, s] of perPand) {
      await tx.insert(recoverySample).values({
        recovery: rec!.id,
        buildingId: pand,
        type: s.type,
        status: s.status ?? null,
        pileType: s.pileType ?? null,
        facade: s.facade?.length ? s.facade : null,
        recoveryDate: s.recoveryDate ?? null,
        permit: s.permit?.trim() || null,
        permitDate: s.permitDate ?? null,
        contractor: contractorId,
        note: s.note?.trim() || null,
        metadata: { dataops: { dossier_id: id } },
      });
    }
    await recordEvent({ recovery: rec!.id }, "imported", { actor: u.id }, tx);
    await tx.update(dossier).set({ recoveryId: rec!.id }).where(eq(dossier.id, id));
    return { recoveryId: rec!.id, samples: perPand.size, auditStatus };
  });

  await addEntry({
    dossierId: id, kind: "status", actorKind: "reviewer", actor: u.id,
    text: `Herstel vastgelegd — ${created.samples} pand${created.samples === 1 ? "" : "en"}`,
    body: { recovery_id: created.recoveryId }, visibleToMelder: true,
  });

  return c.json({ ok: true, ...created });
});

export default dataopsRecovery;
