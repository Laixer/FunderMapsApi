import { Hono } from "hono";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../db/client.ts";
import { dossier, artifact, extraction, extractionField, verdict } from "../db/schema/dataops.ts";
import { inquiry, inquirySample } from "../db/schema/report.ts";
import { attribution, fileResource, user as userTable } from "../db/schema/application.ts";
import { address as geocoderAddress } from "../db/schema/geocoder.ts";
import { s3Client } from "../lib/s3.ts";
import { env } from "../config.ts";
import { recordEvent } from "../lib/dossier-events.ts";
import { assertOrgPermission } from "../lib/auth-helpers.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * Stage 10: commit.
 *
 * An accepted dossier becomes the same rows the invoer app writes -- one
 * report.inquiry, one attribution, one report.inquiry_sample per address --
 * so nothing downstream (the model, the WS, the tiles) can tell a reviewed
 * document from a typed one. Only values a person confirmed or corrected land;
 * pending, rejected and superseded never do.
 *
 * Provenance is explicit twice: attribution.creator is the `dataops@` service
 * user with the reviewer as reviewer (the invoer rule "reviewer differs from
 * creator" holds), and every sample carries metadata.dataops = {dossier_id,
 * extraction_field_ids} so a value can be traced back to the citation it
 * came from.
 *
 * The document is COPIED from dataops/ to inquiry-report/: the pipeline never
 * writes to inquiry-report/ (the survey record), and the commit is the one
 * place a reviewed file legitimately enters it.
 */
const commit = new Hono<AppEnv>();

const SERVICE_USER_EMAIL = "dataops@fundermaps.com";
/** application.contractor 10 = FunderMaps B.V., the contractor on 10,983 attributions. */
const CONTRACTOR_FUNDERMAPS = 10;

/** What the melder's label (files[].category) means as an inquiry type. */
const TYPE_FROM_CATEGORY: Record<string, string> = {
  foundationresearch: "foundation_research",
  archieveresearch: "archive_research",
  quickscan: "quickscan",
  herstelbewijs: "note",
  foto: "note",
  overig: "note",
};

const INQUIRY_TYPES = new Set([
  "monitoring", "note", "quickscan", "unknown", "demolition_research", "second_opinion",
  "archive_research", "architectural_research", "foundation_advice", "inspectionpit",
  "foundation_research", "additional_research", "ground_water_level_research",
  "soil_investigation", "facade_scan",
]);

type SampleValues = Partial<typeof inquirySample.$inferInsert>;

/**
 * extraction_field.field -> inquiry_sample column. Keys are the column names
 * already (English, by rule); the few that differ are named here. Fields with
 * no column (recovery_note, follow_up_note) go into the sample note.
 */
function applyField(values: SampleValues, notes: string[], field: string, value: string) {
  // Drizzle types some numeric columns as number and others (numeric) as string.
  const numN = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : undefined);
  const num = (v: string) => (Number.isFinite(parseFloat(v)) ? String(parseFloat(v)) : undefined);
  switch (field) {
    case "foundation_type": values.foundationType = value; break;
    case "built_year": if (/^\d{4}$/.test(value)) values.builtYear = `${value}-01-01`; break;
    case "foundation_quality": values.overallQuality = value; break;
    case "recovery_advised": values.recoveryAdvised = value === "true"; break;
    case "recovery_note": notes.push(`Hersteladvies: ${value}`); break;
    case "follow_up_note": notes.push(`Vervolgadvies: ${value}`); break;
    case "enforcement_term": values.enforcementTerm = value; break;
    case "groundwater_level": values.groundwaterLevelTemp = numN(value); break;
    case "wood_level": values.woodLevel = numN(value); break;
    case "pile_head_level": values.pileHeadLevel = numN(value); break;
    case "pile_tip_level": values.pileTipLevel = numN(value); break;
    case "concrete_charger_length": values.concreteChargerLength = numN(value); break;
    case "pile_diameter_top": values.pileDiameterTop = numN(value); break;
    case "pile_diameter_bottom": values.pileDiameterBottom = numN(value); break;
    case "pile_distance_length": values.pileDistanceLength = numN(value); break;
    case "wood_type": values.woodType = value; break;
    case "wood_penetration_depth": values.woodPenetrationDepth = numN(value); break;
    case "wood_encroachment": values.woodEncroachment = value; break;
    case "foundation_depth": values.foundationDepth = numN(value); break;
    case "groundlevel": values.groundLevel = numN(value); break;
    case "damage_cause": values.damageCause = value; break;
    case "damage_characteristics": values.damageCharacteristics = value; break;
    case "crack_facade_front_type": values.crackFacadeFrontType = value; break;
    case "crack_facade_back_type": values.crackFacadeBackType = value; break;
    case "crack_indoor_type": values.crackIndoorType = value; break;
    case "skewed_parallel": values.skewedParallel = numN(value); break;
    case "skewed_perpendicular": values.skewedPerpendicular = numN(value); break;
    default: notes.push(`${field}: ${value}`);
  }
}

commit.post("/dossier/:id/commit", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const u = c.get("user");
  const orgId = u.organizations[0]?.id;
  if (!orgId) throw new ForbiddenError("User is not a member of any organization");
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  const body = await c.req.json<{ type?: string; documentDate?: string; note?: string }>().catch(() => ({}) as { type?: string; documentDate?: string; note?: string });
  if (body.type && !INQUIRY_TYPES.has(body.type)) throw new ValidationError([`unknown inquiry type: ${body.type}`]);
  if (body.documentDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.documentDate)) throw new ValidationError(["documentDate must be YYYY-MM-DD"]);

  const [head] = await db.select().from(dossier).where(eq(dossier.id, id)).limit(1);
  if (!head) throw new NotFoundError("dossier not found");
  if (head.inquiryId) throw new ValidationError([`dossier already committed as inquiry ${head.inquiryId}`]);

  const [svc] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, SERVICE_USER_EMAIL)).limit(1);
  if (!svc) throw new ValidationError([`service user ${SERVICE_USER_EMAIL} is missing`]);

  const artifacts = await db.select().from(artifact).where(eq(artifact.dossierId, id)).orderBy(asc(artifact.id));
  const document = artifacts.find((a) => a.storageKey.startsWith("dataops/") || a.storageKey.startsWith("intake/"));
  if (!document) throw new ValidationError(["dossier has no document to commit"]);

  // Judged values only. The latest verdict per field wins; 'corrected' carries
  // the reviewer's value in final_value.
  const judged = await db
    .select({
      fieldId: extractionField.id,
      field: extractionField.field,
      value: extractionField.value,
      addressId: extractionField.addressId,
      addressText: extractionField.addressText,
      outcome: verdict.outcome,
      finalValue: verdict.finalValue,
      decidedAt: verdict.decidedAt,
    })
    .from(extractionField)
    .innerJoin(extraction, eq(extraction.id, extractionField.extractionId))
    .innerJoin(artifact, eq(artifact.id, extraction.artifactId))
    .innerJoin(verdict, eq(verdict.extractionFieldId, extractionField.id))
    .where(and(eq(artifact.dossierId, id), inArray(verdict.outcome, ["confirmed", "corrected"])))
    .orderBy(asc(verdict.decidedAt));
  const latest = new Map<number, (typeof judged)[number]>();
  for (const j of judged) latest.set(j.fieldId, j);

  // One sample per address. Document-level values go on the dossier's own
  // building (its first address); per-address values on the address they
  // resolved to. Unresolved address rows are kept in the note, never guessed.
  const groups = new Map<string, { values: SampleValues; notes: string[]; ids: number[] }>();
  const group = (key: string) => {
    if (!groups.has(key)) groups.set(key, { values: {}, notes: [], ids: [] });
    return groups.get(key)!;
  };
  const unresolved: string[] = [];
  for (const j of latest.values()) {
    const value = (j.outcome === "corrected" ? j.finalValue : j.value) ?? "";
    if (!value) continue;
    if (j.addressText && !j.addressId) { unresolved.push(`${j.addressText}: ${j.field} = ${value}`); continue; }
    const g = group(j.addressId ?? "");
    applyField(g.values, g.notes, j.field, value);
    g.ids.push(j.fieldId);
  }

  // Resolve the document-level group to the dossier's building.
  let mainAddress: { id: string; building: string } | null = null;
  if (head.buildingId) {
    const [a] = await db
      .select({ id: geocoderAddress.id, building: geocoderAddress.buildingId })
      .from(geocoderAddress)
      .where(eq(geocoderAddress.buildingId, head.buildingId))
      .orderBy(asc(geocoderAddress.buildingNumber))
      .limit(1);
    if (a?.building) mainAddress = { id: a.id, building: a.building };
  }
  const addressIds = [...groups.keys()].filter(Boolean);
  const resolvedRows = addressIds.length
    ? await db.select({ id: geocoderAddress.id, building: geocoderAddress.buildingId }).from(geocoderAddress).where(inArray(geocoderAddress.id, addressIds))
    : [];
  const byAddress = new Map(resolvedRows.map((r) => [r.id, r]));

  // Type: explicit > the melder's label > what the pages looked like.
  const type = body.type ?? TYPE_FROM_CATEGORY[document.declaredCategory ?? ""] ?? (document.lane === "text" ? "foundation_research" : "archive_research");
  const documentDate = body.documentDate ?? head.receivedAt.toISOString().slice(0, 10);
  const documentName = document.originalFilename?.replace(/^[0-9a-f]{16}-/, "") ?? `dossier-${id}`;

  // Copy the file into the survey record under a fresh uuid key.
  const ext = (document.storageKey.split(".").pop() ?? "pdf").toLowerCase();
  const fileName = `${crypto.randomUUID()}.${ext}`;
  const targetKey = `inquiry-report/${fileName}`;
  await s3Client().send(new CopyObjectCommand({
    Bucket: env.S3_BUCKET!,
    CopySource: `${env.S3_BUCKET!}/${document.storageKey}`,
    Key: targetKey,
    MetadataDirective: "COPY",
  }));

  const inquiryNote = [body.note?.trim(), head.subject ? `Dossier: ${head.subject}` : null, head.reference ? `Meldcode ${head.reference}` : null, unresolved.length ? `Niet aan een adres gekoppeld:\n${unresolved.join("\n")}` : null]
    .filter(Boolean)
    .join("\n");

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
      .values({ reviewer: u.id, creator: svc.id, owner: orgId, contractor: CONTRACTOR_FUNDERMAPS })
      .returning();
    const [inq] = await tx
      .insert(inquiry)
      .values({
        documentName,
        inspection: false,
        jointMeasurement: false,
        floorMeasurement: false,
        note: inquiryNote || null,
        documentDate,
        documentFile: fileName,
        attribution: attr!.id,
        dataOwnerOrganization: orgId,
        accessPolicy: "private",
        type,
        standardF3o: false,
        auditStatus: "done",
      })
      .returning();

    let samples = 0;
    for (const [key, g] of groups) {
      const addr = key ? byAddress.get(key) : mainAddress;
      if (!addr?.building) continue;
      await tx.insert(inquirySample).values({
        ...g.values,
        inquiry: inq!.id,
        address: addr.id,
        building: addr.building,
        note: g.notes.length ? g.notes.join("\n") : null,
        metadata: { dataops: { dossier_id: id, extraction_field_ids: g.ids } },
      });
      samples++;
    }

    await recordEvent({ inquiry: inq!.id }, "imported", { actor: u.id }, tx);
    await tx
      .update(dossier)
      .set({ inquiryId: inq!.id, outcome: head.outcome ?? "accepted", outcomeNote: head.outcomeNote ?? `Overgenomen als rapportage #${inq!.id}`, outcomeAt: head.outcomeAt ?? new Date() })
      .where(eq(dossier.id, id));
    await tx.execute(sql`
      update ${extractionField} f set state = 'superseded'
      from ${extraction} e join ${artifact} a on a.id = e.artifact_id
      where e.id = f.extraction_id and a.dossier_id = ${id}
        and f.state in ('pending', 'auto_accepted', 'rejected')
        and not exists (select 1 from ${verdict} v where v.extraction_field_id = f.id)`);
    return { inquiryId: inq!.id, samples };
  });

  return c.json({ ok: true, ...created, unresolved });
});

export default commit;
