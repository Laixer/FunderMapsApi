import { Hono } from "hono";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../db/client.ts";
import { dossier, artifact, extraction, extractionField, verdict } from "../db/schema/dataops.ts";
import { inquiry, inquirySample } from "../db/schema/report.ts";
import { attribution, contractor as contractorTable, fileResource, user as userTable } from "../db/schema/application.ts";
import { address as geocoderAddress, building as geocoderBuilding } from "../db/schema/geocoder.ts";
import { s3Client } from "../lib/s3.ts";
import { env } from "../config.ts";
import { recordEvent } from "../lib/dossier-events.ts";
import { addEntry } from "../lib/dossier-entries.ts";
import { sendDossierClosedMail } from "../lib/intake-emails.ts";
import { resolveDocumentDate } from "../lib/document-date.ts";
import { assertOrgPermission } from "../lib/auth-helpers.ts";
import { matchContractor } from "../lib/contractor-match.ts";
import { addressDecisions } from "../lib/dossier-addresses.ts";
import { nummeraanduidingOf } from "../lib/geocoder-id.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.ts";
import { numericOverflows } from "../lib/numeric-limits.ts";
import { MERGEABLE_MIMES, mergeMime, mergeToPdf, mergedName, UnmergeableDocumentError } from "../lib/merge-documents.ts";
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

/**
 * One rapportage the reviewer put together (Don, 2026-10-08): which documents, and what it is.
 * `addressIds` (Don, 2026-10-09): the panden this rapportage is about. An archive piece can cover
 * several panden while a QuickScan in the same dossier covers one, so each rapportage gets its own.
 */
type RapportageInput = { artifactIds: number[]; type?: string; documentDate?: string; contractor?: number; note?: string; addressIds?: string[] };
type CommitBody = { type?: string; documentDate?: string; contractor?: number; note?: string; rapportages?: RapportageInput[] };

const NUMMERAANDUIDING = /^NL\.IMBAG\.NUMMERAANDUIDING\.\d{16}$/;

/** Merging reads every file into memory; past this the reviewer should split the rapportage. */
const MAX_MERGE_BYTES = 200 * 1024 * 1024;

function checkInquiryInput(where: string, v: { type?: string; documentDate?: string; contractor?: number }) {
  const errs: string[] = [];
  if (v.type && !INQUIRY_TYPES.has(v.type)) errs.push(`${where}unknown inquiry type: ${v.type}`);
  if (v.documentDate && !/^\d{4}-\d{2}-\d{2}$/.test(v.documentDate)) errs.push(`${where}documentDate must be YYYY-MM-DD`);
  if (v.contractor != null && (!Number.isInteger(v.contractor) || v.contractor <= 0)) errs.push(`${where}contractor must be a contractor id`);
  return errs;
}

commit.post("/dossier/:id/commit", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const u = c.get("user");
  const orgId = u.organizations[0]?.id;
  if (!orgId) throw new ForbiddenError("User is not a member of any organization");
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  const body = await c.req.json<CommitBody>().catch(() => ({}) as CommitBody);
  const inputErrors = checkInquiryInput("", body);
  if (body.rapportages != null) {
    if (!Array.isArray(body.rapportages) || body.rapportages.length === 0 || body.rapportages.length > 20) {
      inputErrors.push("rapportages must be a list of 1 to 20 rapportages");
    } else {
      body.rapportages.forEach((r, i) => {
        if (!Array.isArray(r.artifactIds) || r.artifactIds.length === 0 || !r.artifactIds.every((a) => Number.isInteger(a) && a > 0)) {
          inputErrors.push(`rapportage ${i + 1}: artifactIds must be a non-empty list of document ids`);
        }
        if (r.addressIds != null && (!Array.isArray(r.addressIds) || r.addressIds.length === 0 || r.addressIds.length > 200 || !r.addressIds.every((a) => typeof a === "string" && NUMMERAANDUIDING.test(a)))) {
          inputErrors.push(`rapportage ${i + 1}: addressIds must be a non-empty list of BAG nummeraanduidingen`);
        }
        inputErrors.push(...checkInquiryInput(`rapportage ${i + 1}: `, r));
      });
    }
  }
  if (inputErrors.length) throw new ValidationError(inputErrors);

  const [head] = await db.select().from(dossier).where(eq(dossier.id, id)).limit(1);
  if (!head) throw new NotFoundError("dossier not found");
  if (head.inquiryId) throw new ValidationError([`dossier already committed as inquiry ${head.inquiryId}`]);
  if (head.auditInquiryId) return c.json(await applyAudit(head as typeof head & { auditInquiryId: number }, u.id));

  const [svc] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, SERVICE_USER_EMAIL)).limit(1);
  if (!svc) throw new ValidationError([`service user ${SERVICE_USER_EMAIL} is missing`]);

  const artifacts = await db.select().from(artifact).where(eq(artifact.dossierId, id)).orderBy(asc(artifact.id));
  const isDocument = (a: (typeof artifacts)[number]) => a.storageKey.startsWith("dataops/") || a.storageKey.startsWith("intake/");
  const firstDocument = artifacts.find(isDocument);
  if (!firstDocument) throw new ValidationError(["dossier has no document to commit"]);

  // What becomes a rapportage. With `rapportages` (the Studio since
  // 2026-10-08): each listed group of documents is one rapportage with its
  // own values, type, date and bureau; a document in no group lapses
  // ("vervalt") and nothing read from it is taken over. Without it, the
  // behaviour before: one rapportage for the whole dossier, values from every
  // document, the first document as its file (API #223), for an older Studio.
  const byArtifactId = new Map(artifacts.map((a) => [a.id, a] as const));
  type Plan = { label: string; files: (typeof artifacts)[number][]; only: Set<number> | null; addressIds: string[] | null; explicit: { type?: string; documentDate?: string; contractor?: number; note?: string } };
  let plans: Plan[];
  if (body.rapportages) {
    const seen = new Set<number>();
    const errs: string[] = [];
    plans = body.rapportages.map((r, i) => {
      const files = r.artifactIds.map((aid) => {
        const a = byArtifactId.get(aid);
        if (!a || !isDocument(a)) errs.push(`rapportage ${i + 1}: document ${aid} is not a document of this dossier`);
        if (seen.has(aid)) errs.push(`rapportage ${i + 1}: document ${aid} is already in another rapportage`);
        seen.add(aid);
        return a!;
      });
      return {
        label: `Rapportage ${i + 1}`, files, only: new Set(r.artifactIds), addressIds: r.addressIds ? [...new Set(r.addressIds)] : null,
        explicit: { type: r.type, documentDate: r.documentDate, contractor: r.contractor, note: r.note },
      };
    });
    if (errs.length) throw new ValidationError(errs);
  } else {
    plans = [{ label: "Rapportage", files: [firstDocument], only: null, addressIds: null, explicit: { type: body.type, documentDate: body.documentDate, contractor: body.contractor, note: body.note } }];
  }

  // Judged values only. The latest verdict per field wins; 'corrected' carries
  // the reviewer's value in final_value.
  const judged = await db
    .select({
      fieldId: extractionField.id,
      artifactId: extraction.artifactId,
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
    .where(and(eq(artifact.dossierId, id), inArray(verdict.outcome, ["confirmed", "corrected"]), inArray(extractionField.state, ["confirmed", "corrected"])))
    .orderBy(asc(verdict.decidedAt));
  // Only a field that is confirmed or corrected NOW counts (the state filter
  // above): one that was confirmed, reopened and then rejected or left open
  // still has its old confirming verdict, and taking that would commit a
  // value the reviewer withdrew (#355 reopen, fixed 2026-09-23).
  const latest = new Map<number, (typeof judged)[number]>();
  for (const j of judged) latest.set(j.fieldId, j);

  // What the reviewer decided about the addresses themselves (ClientApp #333
  // part C): a rejected address is not part of this dossier, so nothing under
  // it becomes a sample even when a value was confirmed before the address
  // was refused; a confirmed address gets a sample even with no values.
  const decisions = await addressDecisions(id);

  // Resolve the document-level group to the dossier's building.
  // The address the melder submitted wins (#200). Resolving the document group
  // to the building's first address writes the report onto a neighbour whenever
  // a pand has several front doors: FM2026-000184 was a report about Nieuwstraat
  // 115 and its foundation type was committed to Nieuwstraat 109, because
  // building_number sorts as text and "109" precedes "115". The melder noticed.
  let mainAddress: { id: string; building: string } | null = null;
  if (head.bagId) {
    // The sample stores the nummeraanduiding (Worker #158 step 2).
    const [a] = await db
      .select({ id: geocoderAddress.externalId, building: geocoderAddress.buildingId })
      .from(geocoderAddress)
      .where(eq(geocoderAddress.externalId, nummeraanduidingOf(head.bagId)))
      .limit(1);
    if (a?.building) mainAddress = { id: a.id, building: a.building };
  }
  if (!mainAddress && head.buildingId) {
    const [a] = await db
      .select({ id: geocoderAddress.externalId, building: geocoderAddress.buildingId })
      .from(geocoderAddress)
      .where(eq(geocoderAddress.buildingId, head.buildingId))
      .orderBy(asc(geocoderAddress.buildingNumber))
      .limit(1);
    if (a?.building) mainAddress = { id: a.id, building: a.building };
  }
  // The panden a rapportage names must be the dossier's own: the melder's
  // address, an address the reviewer confirmed, or one a value was read for.
  // A refused address is not part of the dossier.
  const chosen = plans.flatMap((p) => p.addressIds ?? []);
  if (chosen.length) {
    const known = new Set([...latest.values()].map((j) => j.addressId).concat([...decisions.keys()], [mainAddress?.id ?? null]));
    const errs = plans.flatMap((p) =>
      (p.addressIds ?? []).flatMap((a) =>
        decisions.get(a) === "rejected" ? [`${p.label}: address ${a} was rejected for this dossier`]
          : known.has(a) ? [] : [`${p.label}: address ${a} is not an address of this dossier`]),
    );
    if (errs.length) throw new ValidationError(errs);
  }
  // Group keys are what the fields store: BAG nummeraanduidingen.
  const addressIds = [...new Set([...latest.values()].map((j) => j.addressId).concat([...decisions.keys()], chosen).filter((a): a is string => !!a))];
  const resolvedRows = addressIds.length
    ? await db.select({ id: geocoderAddress.externalId, building: geocoderAddress.buildingId }).from(geocoderAddress).where(inArray(geocoderAddress.externalId, addressIds))
    : [];
  const byAddress = new Map(resolvedRows.map((r) => [r.id, r] as const));

  // The pand's construction year, the date estimate for an archive drawing.
  // `dossier.building_id` is the BAG pand id, i.e. `building.external_id`;
  // matching it against the internal `building.id` found nothing for any of
  // the 3,516 dossiers with a pand, so the estimate never fired (2026-09-17).
  const builtYear = head.buildingId
    ? (await db.select({ builtYear: geocoderBuilding.built_year }).from(geocoderBuilding).where(eq(geocoderBuilding.external_id, head.buildingId)).limit(1))[0]?.builtYear ?? null
    : null;
  let contractorRows: { id: number; name: string }[] | null = null;
  const contractors = async () =>
    (contractorRows ??= (await db.select({ id: contractorTable.id, name: contractorTable.name }).from(contractorTable)).filter(
      (r): r is { id: number; name: string } => !!r.name,
    ));

  // Everything each rapportage will write, worked out before a single file is
  // copied, so a refusal (no date, a value too big) leaves nothing behind.
  type Group = { values: SampleValues; notes: string[]; ids: number[]; raw: string[]; label: string };
  type Prepared = {
    plan: Plan; groups: Map<string, Group>; unresolved: string[]; type: string; documentDate: string; documentName: string;
    contractorId: number; contractorUnmatched: string | null; inquiryNote: string; emptySamples: number; auditStatus: string;
  };
  const prepared: Prepared[] = [];
  let skippedRejected = 0;
  for (const plan of plans) {
    const where = plans.length > 1 ? `${plan.label}: ` : "";
    const groups = new Map<string, Group>();
    const group = (key: string, label: string) => {
      if (!groups.has(key)) groups.set(key, { values: {}, notes: [], ids: [], raw: [], label });
      return groups.get(key)!;
    };
    const unresolved: string[] = [];
    const documentValues = new Map<string, { value: string; fieldId: number }>();
    for (const j of latest.values()) {
      if (plan.only && !plan.only.has(j.artifactId)) continue;
      const value = (j.outcome === "corrected" ? j.finalValue : j.value) ?? "";
      if (!value) continue;
      if (DOCUMENT_FIELDS.has(j.field)) { documentValues.set(j.field, { value: value.trim(), fieldId: j.fieldId }); continue; }
      if (j.addressId && decisions.get(j.addressId) === "rejected") { skippedRejected++; continue; }
      if (j.addressText && !j.addressId) { unresolved.push(`${j.addressText}: ${j.field} = ${value}`); continue; }
      const g = group(j.addressId ?? "", j.addressText ?? "Het rapport");
      applyField(g.values, g.notes, j.field, value);
      g.ids.push(j.fieldId);
      g.raw.push(`${j.field} = ${value}`);
    }
    if (plan.addressIds) {
      // The reviewer named this rapportage's panden (Don, 2026-10-09). What
      // the document says without naming an address is about each of them,
      // not only the melder's: the second address of dossiers 3628 and 6159
      // got an empty sample and was filled in by hand after the commit. A
      // value read for one address stays on that address and wins over the
      // document-level value, as with the twin below.
      const docGroup = groups.get("");
      groups.delete("");
      for (const addressId of plan.addressIds) {
        const g = group(addressId, addressId);
        if (!docGroup) continue;
        g.values = { ...docGroup.values, ...g.values };
        g.notes = [...docGroup.notes, ...g.notes];
        g.ids = [...docGroup.ids, ...g.ids];
        g.raw = [...docGroup.raw, ...g.raw];
      }
    } else if (plan === plans[0]) {
      // A confirmed address without values belongs to the dossier, so it goes
      // on the first rapportage only: one empty sample, not one per document.
      for (const [addressId, state] of decisions) {
        if (state === "confirmed" && !groups.has(addressId)) group(addressId, addressId);
      }
    }

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
    const first = plan.files[0]!;
    const judgedType = documentValues.get("inquiry_type")?.value;
    const judgedDate = documentValues.get("document_date")?.value;
    const type = plan.explicit.type
      ?? (judgedType && INQUIRY_TYPES.has(judgedType) ? judgedType : undefined)
      ?? TYPE_FROM_CATEGORY[first.declaredCategory ?? ""]
      ?? (first.lane === "text" ? "foundation_research" : "archive_research");
    // The day the melding arrived is never the document's date (#338, Don
    // 2026-09-14): an archive drawing without a readable date gets the pand's
    // construction year as an estimate; anything else needs the reviewer.
    const dateChoice = resolveDocumentDate({ explicit: plan.explicit.documentDate, judged: judgedDate, type, builtYear });
    if (!dateChoice) {
      throw new ValidationError([`${where}documentDate: geen rapportdatum in het document gevonden; vul de datum in`]);
    }
    const documentDate = dateChoice.date;
    const names = plan.files.map((f) => f.originalFilename ?? `document-${f.id}`);
    const documentName = plan.files.length > 1 ? mergedName(names) : (first.originalFilename?.replace(/^[0-9a-f]{16}-/, "") ?? `dossier-${id}`);

    // The bureau. Explicit at commit (the Studio's Uitvoerder control, an id)
    // > the reviewer's correction (also an id) > the pipeline's reading, the
    // name as printed, matched against application.contractor. No match means
    // FunderMaps B.V. as before, with the printed name kept in the note so a
    // person can add the row. An explicit id that does not exist is an error,
    // not a silent fallback (ClientApp #333, point 8).
    const judgedContractor = documentValues.get("contractor")?.value;
    let contractorId = CONTRACTOR_FUNDERMAPS;
    let contractorUnmatched: string | null = null;
    if (plan.explicit.contractor != null) {
      const explicit = (await contractors()).find((r) => r.id === plan.explicit.contractor);
      if (!explicit) throw new ValidationError([`${where}unknown contractor: ${plan.explicit.contractor}`]);
      contractorId = explicit.id;
    } else if (judgedContractor) {
      const rows = await contractors();
      const byId = /^\d+$/.test(judgedContractor) ? rows.find((r) => r.id === Number(judgedContractor)) : undefined;
      const match = byId ?? matchContractor(judgedContractor, rows);
      if (match) contractorId = match.id;
      else contractorUnmatched = judgedContractor;
    }

    const inquiryNote = [
      plan.explicit.note?.trim(),
      head.subject ? `Dossier: ${head.subject}` : null,
      head.reference ? `Meldcode ${head.reference}` : null,
      plan.files.length > 1 ? `Samengevoegd uit ${plan.files.length} bestanden: ${names.join(", ")}` : null,
      contractorUnmatched ? `Uitvoerder (niet in de lijst): ${contractorUnmatched}` : null,
      dateChoice.source === "built_year" ? `Rapportdatum geschat op het bouwjaar (${documentDate.slice(0, 4)}); geen datum in het document gevonden` : null,
      unresolved.length ? `Niet aan een adres gekoppeld:\n${unresolved.join("\n")}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    // Nothing taken over (the pipeline read nothing, or the reviewer refused it
    // all) still makes an inquiry: the document is archived and the person
    // fills the samples in by hand. That record is not done, it is pending --
    // and the API only accepts sample writes on todo/pending/rejected.
    const landing = [...groups.entries()].filter(([key]) => (key ? byAddress.get(key) : mainAddress)?.building);
    const willHaveSamples = landing.length > 0;
    // An address the reviewer added without values (part C) lands as an empty
    // sample: the record is not done until someone fills it in.
    const emptySamples = landing.filter(([, g]) => Object.keys(g.values).length === 0).length;
    const auditStatus = willHaveSamples && emptySamples === 0 ? "done" : "pending";

    // A value that does not fit its column would roll the commit back with a
    // bare 500 (Worker #223): name the field and its limit instead.
    const tooBig = [...groups.values()].flatMap((g) => numericOverflows(inquirySample, g.values)).map((e) => `${where}${e}`);
    if (tooBig.length) throw new ValidationError(tooBig);

    if (plan.files.length > 1) {
      const errs = plan.files.filter((f) => !MERGEABLE_MIMES.has(mergeMime({ name: f.originalFilename ?? "", mimeType: f.mimeType }) ?? "")).map(
        (f) => `${where}${f.originalFilename ?? f.id}: dit soort bestand kan niet worden samengevoegd; zet het in een eigen rapportage`,
      );
      const total = plan.files.reduce((t, f) => t + (f.sizeBytes ?? 0), 0);
      if (total > MAX_MERGE_BYTES) errs.push(`${where}samen ${Math.round(total / 1e6)} MB: te groot om samen te voegen; verdeel over meer rapportages`);
      if (errs.length) throw new ValidationError(errs);
    }

    prepared.push({ plan, groups, unresolved, type, documentDate, documentName, contractorId, contractorUnmatched, inquiryNote, emptySamples, auditStatus });
  }

  // The files. One document is copied into the survey record under a fresh
  // uuid key; several are merged into one PDF there.
  const files: { fileName: string; originalFilename: string; sizeBytes: number | null; mimeType: string }[] = [];
  for (const p of prepared) {
    if (p.plan.files.length === 1) {
      const doc = p.plan.files[0]!;
      const ext = (doc.storageKey.split(".").pop() ?? "pdf").toLowerCase();
      const fileName = `${crypto.randomUUID()}.${ext}`;
      await s3Client().send(new CopyObjectCommand({
        Bucket: env.S3_BUCKET!,
        CopySource: `${env.S3_BUCKET!}/${doc.storageKey}`,
        Key: `inquiry-report/${fileName}`,
        MetadataDirective: "COPY",
      }));
      files.push({
        fileName,
        originalFilename: doc.originalFilename ?? fileName,
        sizeBytes: doc.sizeBytes,
        mimeType: doc.mimeType ?? (ext === "pdf" ? "application/pdf" : `image/${ext === "jpg" ? "jpeg" : ext}`),
      });
    } else {
      const parts = [];
      for (const doc of p.plan.files) {
        const obj = await s3Client().send(new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: doc.storageKey }));
        parts.push({ name: doc.originalFilename ?? `document-${doc.id}`, mimeType: doc.mimeType, bytes: await obj.Body!.transformToByteArray() });
      }
      let merged: Uint8Array;
      try {
        merged = await mergeToPdf(parts);
      } catch (err) {
        if (err instanceof UnmergeableDocumentError) throw new ValidationError([`${p.plan.label}: ${err.message}; zet het in een eigen rapportage`]);
        throw new ValidationError([`${p.plan.label}: samenvoegen tot één PDF is mislukt (${(err as Error).message})`]);
      }
      const fileName = `${crypto.randomUUID()}.pdf`;
      await s3Client().send(new PutObjectCommand({ Bucket: env.S3_BUCKET!, Key: `inquiry-report/${fileName}`, Body: merged, ContentType: "application/pdf" }));
      files.push({ fileName, originalFilename: `${p.documentName.replace(/ \(\d+ bestanden\)$/, "")}.pdf`, sizeBytes: merged.byteLength, mimeType: "application/pdf" });
    }
  }

  const created = await db.transaction(async (tx) => {
    const made = [];
    for (const [i, p] of prepared.entries()) {
      const file = files[i]!;
      await tx.insert(fileResource).values({ key: `inquiry-report/${file.fileName}`, originalFilename: file.originalFilename, status: "active", sizeBytes: file.sizeBytes, mimeType: file.mimeType });
      const [attr] = await tx
        .insert(attribution)
        .values({ reviewer: u.id, creator: svc.id, owner: orgId, contractor: p.contractorId })
        .returning();
      const [inq] = await tx
        .insert(inquiry)
        .values({
          documentName: p.documentName,
          inspection: false,
          jointMeasurement: false,
          floorMeasurement: false,
          note: p.inquiryNote || null,
          documentDate: p.documentDate,
          documentFile: file.fileName,
          attribution: attr!.id,
          dataOwnerOrganization: orgId,
          accessPolicy: "private",
          type: p.type,
          standardF3o: false,
          auditStatus: p.auditStatus,
        })
        .returning();

      let samples = 0;
      for (const [key, g] of p.groups) {
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
          metadata: { dataops: { dossier_id: id, extraction_field_ids: g.ids, ...(p.plan.only ? { artifact_ids: [...p.plan.only] } : {}) } },
        });
        samples++;
      }
      // A rapportage committed without a single value still has an address:
      // the melder's pand. Without a sample it would float free of any
      // address (Don, inquiry 158720, 2026-09-14). One empty sample, pending,
      // ties it to the pand for someone to complete by hand.
      if (samples === 0 && mainAddress?.building) {
        await tx.insert(inquirySample).values({
          builtYear: null,
          inquiry: inq!.id,
          address: mainAddress.id,
          building: mainAddress.building,
          note: "Geen waarden overgenomen uit het document; adres van de melding",
          metadata: { dataops: { dossier_id: id, extraction_field_ids: [], ...(p.plan.only ? { artifact_ids: [...p.plan.only] } : {}) } },
        });
        samples++;
      }
      await recordEvent({ inquiry: inq!.id }, "imported", { actor: u.id }, tx);
      made.push({ inquiryId: inq!.id, samples, emptySamples: p.emptySamples, auditStatus: p.auditStatus, type: p.type, documentDate: p.documentDate, contractorId: p.contractorId, contractorUnmatched: p.contractorUnmatched, documentName: p.documentName, artifactIds: p.plan.files.map((f) => f.id) });
    }

    const ids = made.map((m) => `#${m.inquiryId}`).join(", ");
    await tx
      .update(dossier)
      .set({
        inquiryId: made[0]!.inquiryId,
        outcome: head.outcome ?? "accepted",
        outcomeNote: head.outcomeNote ?? (made.length === 1 ? `Overgenomen als rapportage ${ids}` : `Overgenomen als ${made.length} rapportages: ${ids}`),
        outcomeAt: head.outcomeAt ?? new Date(),
      })
      .where(eq(dossier.id, id));
    await tx.execute(sql`
      update ${extractionField} f set state = 'superseded'
      from ${extraction} e join ${artifact} a on a.id = e.artifact_id
      where e.id = f.extraction_id and a.dossier_id = ${id}
        and f.state in ('pending', 'auto_accepted', 'rejected')
        and not exists (select 1 from ${verdict} v where v.extraction_field_id = f.id)`);
    return made;
  });

  // Moment 3 of tracker #1020. A dossier closed as 'accepted' first and
  // committed later gets ONE mail: the send log in dataops.dossier_mail is
  // keyed on (dossier, kind).
  await sendDossierClosedMail([id]);

  const totalSamples = created.reduce((t, m) => t + m.samples, 0);
  await addEntry({
    dossierId: id, kind: "status", actorKind: "reviewer", actor: u.id,
    text: created.length === 1
      ? `Overgenomen als rapportage — ${totalSamples} adres${totalSamples === 1 ? "" : "sen"}`
      : `Overgenomen als ${created.length} rapportages (${created.map((m) => `#${m.inquiryId}`).join(", ")}) — ${totalSamples} adres${totalSamples === 1 ? "" : "sen"}`,
    body: { inquiry_id: created[0]!.inquiryId, inquiry_ids: created.map((m) => m.inquiryId) }, visibleToMelder: true,
  });

  const unresolved = prepared.flatMap((p) => p.unresolved);
  const firstMade = created[0]!;
  return c.json({
    ok: true,
    // The first rapportage in the old top-level shape, so an older Studio keeps working.
    ...firstMade,
    samples: totalSamples,
    skippedRejected,
    rapportages: created,
    unresolved,
  });
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
    .where(and(eq(artifact.dossierId, head.id), inArray(verdict.outcome, ["confirmed", "corrected"]), inArray(extractionField.state, ["confirmed", "corrected"])))
    .orderBy(asc(verdict.decidedAt));
  const latest = new Map<number, (typeof judged)[number]>();
  for (const j of judged) latest.set(j.fieldId, j);
  const decisions = await addressDecisions(head.id);

  const samples = await db
    .select({ id: inquirySample.id, address: inquirySample.address, building: inquirySample.building, note: inquirySample.note })
    .from(inquirySample)
    .where(eq(inquirySample.inquiry, inquiryId));
  const byAddress = new Map(samples.map((s) => [s.address, s]));
  // Same preference as the commit path (#200): a pand can carry several samples
  // -- Nieuwstraat 109 and 115 are one building -- so match the melder's own
  // address first and only then fall back to whichever sits on the building.
  const submitted = head.bagId ? nummeraanduidingOf(head.bagId) : null;
  const mainSample =
    samples.length === 1
      ? samples[0]!
      : ((submitted ? samples.find((s) => s.address === submitted) : null) ??
        samples.find((s) => s.building === head.buildingId) ??
        null);

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
    if (j.addressId && decisions.get(j.addressId) === "rejected") continue;
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

  const tooBig = [...updates.values()].flatMap((u) => numericOverflows(inquirySample, u.values));
  if (tooBig.length) throw new ValidationError(tooBig);

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
