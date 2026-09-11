import { Hono } from "hono";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../db/client.ts";
import { dossier, artifact, extraction, extractionField, verdict } from "../db/schema/dataops.ts";
import { inquiry, inquirySample } from "../db/schema/report.ts";
import { attribution, contractor as contractorTable, fileResource, user as userTable } from "../db/schema/application.ts";
import { address as geocoderAddress } from "../db/schema/geocoder.ts";
import { s3Client } from "../lib/s3.ts";
import { env } from "../config.ts";
import { recordEvent } from "../lib/dossier-events.ts";
import { addEntry } from "../lib/dossier-entries.ts";
import { sendDossierClosedMail } from "../lib/intake-emails.ts";
import { assertOrgPermission } from "../lib/auth-helpers.ts";
import { matchContractor } from "../lib/contractor-match.ts";
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
 *
 * What the document says about itself -- document_date, inquiry_type,
 * contractor -- is read by the pipeline like any other field and judged like
 * any other field, but lands on the inquiry (and its attribution), never on a
 * sample. Until 2026-09-07 all three were guessed: the upload date, the
 * melder's label, FunderMaps B.V. as the bureau. A Fugro report from 2014 went
 * in as "archive_research, 2026-09-01", and Don's precedence rule (a 5-year-old
 * funderingsonderzoek beats a 3-year-old QuickScan) keys on exactly that date.
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

/** Judged values that describe the document, not a sample. Keys = extraction_field.field. */
const DOCUMENT_FIELDS = new Set(["document_date", "inquiry_type", "contractor"]);

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

  type CommitBody = { type?: string; documentDate?: string; contractor?: number; note?: string };
  const body = await c.req.json<CommitBody>().catch(() => ({}) as CommitBody);
  if (body.type && !INQUIRY_TYPES.has(body.type)) throw new ValidationError([`unknown inquiry type: ${body.type}`]);
  if (body.documentDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.documentDate)) throw new ValidationError(["documentDate must be YYYY-MM-DD"]);
  if (body.contractor != null && (!Number.isInteger(body.contractor) || body.contractor <= 0)) throw new ValidationError(["contractor must be a contractor id"]);

  const [head] = await db.select().from(dossier).where(eq(dossier.id, id)).limit(1);
  if (!head) throw new NotFoundError("dossier not found");
  if (head.inquiryId) throw new ValidationError([`dossier already committed as inquiry ${head.inquiryId}`]);
  if (head.auditInquiryId) return c.json(await applyAudit(head as typeof head & { auditInquiryId: number }, u.id));

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
  type Group = { values: SampleValues; notes: string[]; ids: number[]; raw: string[]; label: string };
  const groups = new Map<string, Group>();
  const group = (key: string, label: string) => {
    if (!groups.has(key)) groups.set(key, { values: {}, notes: [], ids: [], raw: [], label });
    return groups.get(key)!;
  };
  const unresolved: string[] = [];
  const documentValues = new Map<string, { value: string; fieldId: number }>();
  for (const j of latest.values()) {
    const value = (j.outcome === "corrected" ? j.finalValue : j.value) ?? "";
    if (!value) continue;
    if (DOCUMENT_FIELDS.has(j.field)) { documentValues.set(j.field, { value: value.trim(), fieldId: j.fieldId }); continue; }
    if (j.addressText && !j.addressId) { unresolved.push(`${j.addressText}: ${j.field} = ${value}`); continue; }
    const g = group(j.addressId ?? "", j.addressText ?? "Het rapport");
    applyField(g.values, g.notes, j.field, value);
    g.ids.push(j.fieldId);
    g.raw.push(`${j.field} = ${value}`);
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

  // The document-level group and an address group can be the same pand: a
  // report about Molenwal 15 puts its bouwjaar in the header and its
  // scheefstand in a table under "Molenwal 15". Two samples for one address
  // (rapportage 158274, Don's #321 §5) is what happens without this. The
  // address group wins on a field they both carry; the header fills the gaps.
  const docGroup = groups.get("");
  if (docGroup && mainAddress) {
    const twin = [...groups.keys()].find((key) => key && byAddress.get(key)?.building === mainAddress!.building);
    if (twin) {
      const g = groups.get(twin)!;
      g.values = { ...docGroup.values, ...g.values };
      g.notes = [...docGroup.notes, ...g.notes];
      g.ids = [...docGroup.ids, ...g.ids];
      g.raw = [...docGroup.raw, ...g.raw];
      groups.delete("");
    }
  }

  // A group with nowhere to land: the document-level values when the dossier
  // has no building (every bulk_drop dossier, API #167), or an address whose
  // geocoder row has no pand. Those verdicts used to vanish on commit. They
  // go into the inquiry note next to the unresolved addresses instead, and
  // the reviewer is told, so the sample can be filled in by hand.
  for (const [key, g] of groups) {
    const addr = key ? byAddress.get(key) : mainAddress;
    if (addr?.building) continue;
    for (const line of g.raw) unresolved.push(`${g.label}: ${line}`);
    groups.delete(key);
  }

  // Type and date: explicit at commit > what the reviewer took over from the
  // document > the melder's label / the day it arrived. The judged value has
  // already passed the same validation the body gets; a stray one is skipped,
  // not trusted.
  const judgedType = documentValues.get("inquiry_type")?.value;
  const judgedDate = documentValues.get("document_date")?.value;
  const type = body.type
    ?? (judgedType && INQUIRY_TYPES.has(judgedType) ? judgedType : undefined)
    ?? TYPE_FROM_CATEGORY[document.declaredCategory ?? ""]
    ?? (document.lane === "text" ? "foundation_research" : "archive_research");
  const documentDate = body.documentDate
    ?? (judgedDate && /^\d{4}-\d{2}-\d{2}$/.test(judgedDate) ? judgedDate : undefined)
    ?? head.receivedAt.toISOString().slice(0, 10);
  const documentName = document.originalFilename?.replace(/^[0-9a-f]{16}-/, "") ?? `dossier-${id}`;

  // The bureau. Explicit at commit (the Studio's Uitvoerder control, an id)
  // > the reviewer's correction (also an id) > the pipeline's reading, the
  // name as printed, matched against application.contractor. No match means
  // FunderMaps B.V. as before, with the printed name kept in the note so a
  // person can add the row. An explicit id that does not exist is an error,
  // not a silent fallback (ClientApp #333, point 8).
  const judgedContractor = documentValues.get("contractor")?.value;
  let contractorId = CONTRACTOR_FUNDERMAPS;
  let contractorUnmatched: string | null = null;
  if (body.contractor != null || judgedContractor) {
    const rows = (await db.select({ id: contractorTable.id, name: contractorTable.name }).from(contractorTable))
      .filter((r): r is { id: number; name: string } => !!r.name);
    if (body.contractor != null) {
      const explicit = rows.find((r) => r.id === body.contractor);
      if (!explicit) throw new ValidationError([`unknown contractor: ${body.contractor}`]);
      contractorId = explicit.id;
    } else if (judgedContractor) {
      const byId = /^\d+$/.test(judgedContractor) ? rows.find((r) => r.id === Number(judgedContractor)) : undefined;
      const match = byId ?? matchContractor(judgedContractor, rows);
      if (match) contractorId = match.id;
      else contractorUnmatched = judgedContractor;
    }
  }

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

  const inquiryNote = [body.note?.trim(), head.subject ? `Dossier: ${head.subject}` : null, head.reference ? `Meldcode ${head.reference}` : null, contractorUnmatched ? `Uitvoerder (niet in de lijst): ${contractorUnmatched}` : null, unresolved.length ? `Niet aan een adres gekoppeld:\n${unresolved.join("\n")}` : null]
    .filter(Boolean)
    .join("\n");

  // Nothing taken over (the pipeline read nothing, or the reviewer refused it
  // all) still makes an inquiry: the document is archived and the person
  // fills the samples in by hand. That record is not done, it is pending --
  // and the API only accepts sample writes on todo/pending/rejected.
  const willHaveSamples = [...groups.keys()].some((key) => (key ? byAddress.get(key) : mainAddress)?.building);
  const auditStatus = willHaveSamples ? "done" : "pending";

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
        auditStatus,
      })
      .returning();

    let samples = 0;
    for (const [key, g] of groups) {
      const addr = key ? byAddress.get(key) : mainAddress;
      if (!addr?.building) continue;
      await tx.insert(inquirySample).values({
        ...g.values,
        // Explicit: the report.year domain defaults to CURRENT_TIMESTAMP, so
        // an omitted bouwjaar becomes today's date (30 samples, all from
        // this commit, before 2026-09-08).
        builtYear: g.values.builtYear ?? null,
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
    return { inquiryId: inq!.id, samples, auditStatus, type, documentDate, contractorId, contractorUnmatched };
  });

  // Moment 3 of tracker #1020. A dossier closed as 'accepted' first and
  // committed later gets ONE mail: the send log in dataops.dossier_mail is
  // keyed on (dossier, kind).
  await sendDossierClosedMail([id]);

  await addEntry({
    dossierId: id, kind: "status", actorKind: "reviewer", actor: u.id,
    text: `Overgenomen als rapportage — ${created.samples} adres${created.samples === 1 ? "" : "sen"}`,
    body: { inquiry_id: created.inquiryId }, visibleToMelder: true,
  });

  return c.json({ ok: true, ...created, unresolved });
});

/**
 * The nalezing's commit: no new rapportage. Every confirmed or corrected
 * value goes onto the sample it was compared with (the one on the same
 * address; the document-level group onto the dossier's pand), the document
 * fields onto the inquiry itself, and the rapportage's trail gets an
 * 'audited' event naming the dossier. Values for addresses the report names
 * but we could not match are appended to the inquiry note, as on an intake
 * commit. The dossier then closes, linked to the rapportage.
 */
async function applyAudit(head: typeof dossier.$inferSelect & { auditInquiryId: number }, userId: string) {
  const inquiryId = head.auditInquiryId;
  const [inq] = await db.select({ id: inquiry.id, note: inquiry.note, attribution: inquiry.attribution }).from(inquiry).where(eq(inquiry.id, inquiryId)).limit(1);
  if (!inq) throw new NotFoundError(`rapportage ${inquiryId} not found`);

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
    .where(and(eq(artifact.dossierId, head.id), inArray(verdict.outcome, ["confirmed", "corrected"])))
    .orderBy(asc(verdict.decidedAt));
  const latest = new Map<number, (typeof judged)[number]>();
  for (const j of judged) latest.set(j.fieldId, j);

  const samples = await db
    .select({ id: inquirySample.id, address: inquirySample.address, building: inquirySample.building, note: inquirySample.note })
    .from(inquirySample)
    .where(eq(inquirySample.inquiry, inquiryId));
  const byAddress = new Map(samples.map((s) => [s.address, s]));
  const mainSample = samples.length === 1 ? samples[0]! : (samples.find((s) => s.building === head.buildingId) ?? null);

  // Per target sample: the columns to set and the note lines to append.
  const updates = new Map<number, { values: SampleValues; notes: string[]; ids: number[] }>();
  const forSample = (sid: number) => {
    if (!updates.has(sid)) updates.set(sid, { values: {}, notes: [], ids: [] });
    return updates.get(sid)!;
  };
  const documentValues = new Map<string, string>();
  const unresolved: string[] = [];
  for (const j of latest.values()) {
    const value = (j.outcome === "corrected" ? j.finalValue : j.value) ?? "";
    if (!value) continue;
    if (DOCUMENT_FIELDS.has(j.field)) { documentValues.set(j.field, value.trim()); continue; }
    const target = j.addressId ? byAddress.get(j.addressId) : j.addressText ? undefined : mainSample;
    if (!target) { unresolved.push(`${j.addressText ?? "?"}: ${j.field} = ${value}`); continue; }
    const u = forSample(target.id);
    applyField(u.values, u.notes, j.field, value);
    u.ids.push(j.fieldId);
  }

  // Document fields onto the inquiry. Contractor by the same matching as an
  // intake commit; an unmatched name goes into the note, never a new row.
  const inquiryPatch: Partial<typeof inquiry.$inferInsert> = {};
  const noteLines: string[] = [];
  const t = documentValues.get("inquiry_type");
  if (t && INQUIRY_TYPES.has(t)) inquiryPatch.type = t;
  const d = documentValues.get("document_date");
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) inquiryPatch.documentDate = d;
  const cName = documentValues.get("contractor");
  let contractorId: number | null = null;
  if (cName) {
    const rows = (await db.select({ id: contractorTable.id, name: contractorTable.name }).from(contractorTable)).filter((r): r is { id: number; name: string } => !!r.name);
    const byId = /^\d+$/.test(cName) ? rows.find((r) => r.id === Number(cName)) : undefined;
    const match = byId ?? matchContractor(cName, rows);
    if (match) contractorId = match.id;
    else noteLines.push(`Uitvoerder volgens nalezing (niet in de lijst): ${cName}`);
  }
  if (unresolved.length) noteLines.push(`Nalezing, niet aan een adres gekoppeld:\n${unresolved.join("\n")}`);

  let samplesUpdated = 0;
  let fieldsApplied = 0;
  await db.transaction(async (tx) => {
    for (const [sid, u] of updates) {
      const target = samples.find((s) => s.id === sid)!;
      const note = [target.note, ...u.notes].filter(Boolean).join("\n") || null;
      await tx.update(inquirySample).set({ ...u.values, note }).where(eq(inquirySample.id, sid));
      samplesUpdated++;
      fieldsApplied += u.ids.length;
    }
    if (Object.keys(inquiryPatch).length || noteLines.length) {
      const note = [inq.note, ...noteLines].filter(Boolean).join("\n") || null;
      await tx.update(inquiry).set({ ...inquiryPatch, ...(noteLines.length ? { note } : {}) }).where(eq(inquiry.id, inquiryId));
    }
    if (contractorId) await tx.update(attribution).set({ contractor: contractorId }).where(eq(attribution.id, inq.attribution));

    await recordEvent({ inquiry: inquiryId }, "audited", {
      actor: userId,
      note: `Nalezing (dossier #${head.id}): ${fieldsApplied} waarde${fieldsApplied === 1 ? "" : "n"} bijgewerkt op ${samplesUpdated} adres${samplesUpdated === 1 ? "" : "sen"}` +
        (Object.keys(inquiryPatch).length || contractorId ? ", rapportagegegevens aangepast" : ""),
      metadata: { dossier_id: head.id, fields: fieldsApplied, samples: samplesUpdated, unresolved: unresolved.length },
    }, tx);
    await tx
      .update(dossier)
      .set({ inquiryId, outcome: head.outcome ?? "accepted", outcomeNote: head.outcomeNote ?? `Nalezing doorgevoerd op rapportage #${inquiryId}`, outcomeAt: head.outcomeAt ?? new Date() })
      .where(eq(dossier.id, head.id));
    await tx.execute(sql`
      update ${extractionField} f set state = 'superseded'
      from ${extraction} e join ${artifact} a on a.id = e.artifact_id
      where e.id = f.extraction_id and a.dossier_id = ${head.id}
        and f.state in ('pending', 'auto_accepted', 'rejected')
        and not exists (select 1 from ${verdict} v where v.extraction_field_id = f.id)`);
  });

  await addEntry({
    dossierId: head.id, kind: "status", actorKind: "reviewer", actor: userId,
    text: `Nalezing doorgevoerd: ${fieldsApplied} waarde${fieldsApplied === 1 ? "" : "n"} bijgewerkt op rapportage #${inquiryId}`,
    body: { inquiry_id: inquiryId, fields: fieldsApplied, samples: samplesUpdated }, visibleToMelder: false,
  });

  return { ok: true, inquiryId, audit: true, samples: samplesUpdated, fields: fieldsApplied, auditStatus: "done", unresolved };
}

export default commit;
