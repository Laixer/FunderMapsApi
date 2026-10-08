import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dossier, artifact } from "../db/schema/dataops.ts";
import { ALLOWED_UPLOAD_MIMES, MAX_UPLOAD_BYTES, putObject, uniqueFileName } from "../lib/s3.ts";
import { addEntry } from "../lib/dossier-entries.ts";
import { ingestDossierNow } from "../lib/windmill.ts";
import { assertOrgPermission } from "../lib/auth-helpers.ts";
import { resolveToBuildingId } from "../services/geocoder.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * The staff front door for a document.
 *
 * Until 2026-09-07 the Studio had two: the entry wizard, where a person typed
 * a report's values into forms, and the review lane, where the pipeline read
 * them and a person judged them. Both produced the same rows. The wizard is
 * gone; "Nieuwe rapportage" now drops the document here, the pipeline reads
 * it (kicked immediately via Windmill, the hourly sweep as the safety net) and
 * the reviewer continues in /review. Typing stays possible -- on the samples
 * of the inquiry the commit creates -- but as the fallback, not the default.
 *
 * Deliberately the same rows the public intake writes (a dossier, its
 * artifacts, a `received` entry) so nothing downstream distinguishes a staff
 * upload from a melder's: only `channel` does. No submitter, so none of the
 * melder mails go out, and the reviewer's own question box stays hidden.
 */
const upload = new Hono<AppEnv>();

/**
 * What the uploader says the document is, if they say. Optional since
 * 2026-09-08: the pipeline reads the document's kind itself (inquiry_type,
 * with a citation) and the Worker's gate uses that read, so the Studio no
 * longer asks. Still accepted for a caller that knows.
 */
const CATEGORIES = new Set(["foundationresearch", "archieveresearch", "quickscan", "herstelbewijs", "foto", "overig"]);
const MAX_FILES = 10;

/** The files in a multipart body, checked the same way for a new dossier and an added document. */
function filesOf(form: Record<string, unknown>): File[] {
  const raw = form["input"];
  const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File);
  if (files.length === 0) throw new ValidationError(["Missing 'input' file(s) in multipart body"]);
  if (files.length > MAX_FILES) throw new ValidationError([`At most ${MAX_FILES} files per dossier`]);
  for (const f of files) {
    if (f.size === 0) throw new ValidationError([`Empty file: ${f.name}`]);
    if (f.size > MAX_UPLOAD_BYTES) throw new ValidationError([`File too large: ${f.name} (max ${MAX_UPLOAD_BYTES} bytes)`]);
    const mime = (f.type || "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    if (!ALLOWED_UPLOAD_MIMES.has(mime)) throw new ValidationError([`Unsupported content type: ${f.name} (${mime})`]);
  }
  return files;
}

/** Bytes first, rows second: an artifact row whose key points at nothing is worse than an orphaned object. */
async function storeFiles(files: File[]) {
  const stored: { key: string; name: string; mime: string; size: number }[] = [];
  for (const f of files) {
    const mime = (f.type || "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    const key = `dataops/${uniqueFileName(f.name, mime)}`;
    await putObject(key, new Uint8Array(await f.arrayBuffer()), mime);
    stored.push({ key, name: f.name, mime, size: f.size });
  }
  return stored;
}

upload.post("/dossier", async (c) => {
  const u = c.get("user");
  const orgId = u.organizations[0]?.id;
  if (!orgId) throw new ForbiddenError("User is not a member of any organization");
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  const form = await c.req.parseBody({ all: true });
  const files = filesOf(form);

  const str = (k: string) => { const v = form[k]; return typeof v === "string" ? v.trim() : ""; };
  const category = str("category") || null;
  if (category && !CATEGORIES.has(category)) throw new ValidationError([`unknown category: ${category}`]);
  const subject = str("subject").slice(0, 200) || files[0]!.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 200);
  const building = str("building");

  // The uploader named the building, or did not. Like the public intake, a
  // failed resolve is recorded rather than thrown -- the reviewer sorts it out.
  let buildingId: string | null = null;
  let resolutionStatus: string | null = null;
  if (building) {
    try {
      buildingId = await resolveToBuildingId(building);
      resolutionStatus = "resolved";
    } catch {
      resolutionStatus = "absent";
    }
  }

  // Bytes first, rows second: an artifact row whose key points at nothing is
  // worse than an orphaned object, which the S3 hygiene sweep finds.
  const stored = await storeFiles(files);

  const created = await db.transaction(async (tx) => {
    const [head] = await tx
      .insert(dossier)
      .values({
        channel: "invoer_app",
        subject,
        reference: sql`dataops.generate_reference()`,
        bagId: building || null,
        buildingId,
        resolutionStatus,
        submitter: null,
        payload: { uploadedBy: u.id, organization: orgId, ...(category ? { category } : {}) },
      })
      .returning({ id: dossier.id, reference: dossier.reference });
    if (!head) throw new ValidationError(["dossier not created"]);
    await tx.insert(artifact).values(
      stored.map((s) => ({
        dossierId: head.id,
        storageKey: s.key,
        originalFilename: s.name,
        mimeType: s.mime,
        sizeBytes: s.size,
        declaredCategory: category,
        lane: "none",
      })),
    );
    return head;
  });

  await addEntry({
    dossierId: created.id,
    kind: "received", actorKind: "reviewer", actor: u.id,
    text: `Document geüpload via de Studio (${stored.length} bestand${stored.length === 1 ? "" : "en"})`,
    visibleToMelder: false,
  });

  const job = await ingestDossierNow(created.id);

  return c.json({ id: created.id, reference: created.reference, files: stored.length, reading: job !== null }, 201);
});

/**
 * Add a document to a melding that is already there (Don, 2026-10-08,
 * dossier 6015: the melder sent a WeTransfer link, the pieces behind it are
 * usable, and the Studio had no way to put them in the melding). Also the way
 * in for files a melder mails as a reply, which the inbound webhook does not
 * store (API #230): the reviewer saves them and adds them here.
 *
 * Same rows as an upload -- artifacts under dataops/, lane none -- and the
 * same reading: the pipeline reads only documents without an extraction, so
 * what was read and judged before is left alone. Only on an open dossier: a
 * closed one has had its answer, and a committed one its rapportage.
 */
upload.post("/dossier/:id/document", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  const u = c.get("user");
  const orgId = u.organizations[0]?.id;
  if (!orgId) throw new ForbiddenError("User is not a member of any organization");
  await assertOrgPermission(u.id, orgId, "inquiry", "write");

  const [head] = await db
    .select({ id: dossier.id, outcome: dossier.outcome, inquiryId: dossier.inquiryId, auditInquiryId: dossier.auditInquiryId })
    .from(dossier)
    .where(eq(dossier.id, id))
    .limit(1);
  if (!head) throw new NotFoundError("dossier not found");
  if (head.outcome || head.inquiryId) throw new ConflictError("De melding is al afgehandeld; een bestand toevoegen kan alleen bij een open melding.");
  if (head.auditInquiryId) throw new ValidationError(["Een nalezing leest de bestaande rapportage; voeg daar geen bestand aan toe."]);

  const form = await c.req.parseBody({ all: true });
  const files = filesOf(form);
  const category = typeof form["category"] === "string" ? form["category"].trim() || null : null;
  if (category && !CATEGORIES.has(category)) throw new ValidationError([`unknown category: ${category}`]);

  const stored = await storeFiles(files);
  const rows = await db
    .insert(artifact)
    .values(
      stored.map((s) => ({
        dossierId: id,
        storageKey: s.key,
        originalFilename: s.name,
        mimeType: s.mime,
        sizeBytes: s.size,
        declaredCategory: category,
        lane: "none",
      })),
    )
    .returning({ id: artifact.id });

  await addEntry({
    dossierId: id,
    kind: "status", actorKind: "reviewer", actor: u.id,
    text: `Bestand toegevoegd via de Studio: ${stored.map((s) => s.name).join(", ")}`,
    body: { artifact_ids: rows.map((r) => r.id) },
    visibleToMelder: false,
  });

  const job = await ingestDossierNow(id);

  return c.json({ id, files: stored.length, artifactIds: rows.map((r) => r.id), reading: job !== null }, 201);
});

export default upload;
