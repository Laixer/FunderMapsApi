import { AppError } from "./errors.ts";
import { dossierSchema, type DossierInput } from "./intake-dossier.ts";

// What the melden portal may send, checked before anything is stored: an upload
// grant for one generated key, and a submission whose files must be ones we
// handed out. Moved from the melden app's server (FunderMapsIntake
// server/api/upload-url + submit, 2026-10-30) with its rules and its Dutch
// messages; routes/submission.ts calls these.

/**
 * Public submissions land under `intake/`, flat, keyed by uuid: what arrived,
 * unjudged. Not `incident-report/` (the old loket), not `dataops/` (the
 * pipeline's scratch space), not `inquiry-report/` (evidence behind a committed
 * inquiry) — a submission has not earned that until a reviewer accepts it.
 */
export const INTAKE_PREFIX = "intake/";

const UPLOAD_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/tiff",
  "application/octet-stream",
]);
const EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tif",
};
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * One presigned PUT, scoped to a single generated key: a leaked URL can
 * overwrite exactly one object that nothing points at yet. The melder's file
 * name never reaches the key — it travels in the submission body — which keeps
 * path traversal, unicode surprises and duplicate names out of the bucket.
 */
export function planUpload(body: unknown, uuid: () => string = () => crypto.randomUUID()): { key: string; type: string; size: number } {
  const b = (body ?? {}) as { name?: unknown; size?: unknown; type?: unknown };
  const size = Number(b.size ?? 0);
  const type = String(b.type ?? "");
  if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) throw new AppError(400, "Bestand is te groot of leeg");
  if (!UPLOAD_TYPES.has(type)) throw new AppError(400, "Bestandstype wordt niet ondersteund");
  // Phones hand over HEIC with no content type at all, so fall back to the
  // extension of the melder's own file name rather than refusing a photo that
  // was just taken.
  const fallback = String(b.name ?? "").split(".").pop()?.toLowerCase();
  const ext = EXTENSION[type] ?? (fallback && /^[a-z0-9]{2,5}$/.test(fallback) ? fallback : "bin");
  return { key: `${INTAKE_PREFIX}${uuid()}.${ext}`, type, size };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Two identity formats reach us: PDOK hands back a bare 16-digit
// nummeraanduiding, our own geocoder the NL.IMBAG.* form. Both are accepted.
const BAG_ID = /^(\d{16}|NL\.IMBAG\.(NUMMERAANDUIDING|PAND|VERBLIJFSOBJECT|LIGPLAATS|STANDPLAATS)\.\d+)$/i;
export const MELDCODE = /^FM\d{4}-\d{6}$/;
export const isEmail = (v: string) => EMAIL.test(v);

/** Where a submission came from, recorded next to the answers for a reviewer months later. */
export interface SubmissionSource {
  ip: string;
  agent: string | null;
  referrer: string | null;
}

/**
 * The portal's submission as the dossier input. The browser says which files
 * to attach, so both halves of that claim are checked: here that every key sits
 * under `intake/` (without it a crafted submission could attach
 * `inquiry-report/...` — someone else's evidence — and read it back through the
 * portal), in the route that the object exists.
 */
export function toDossierInput(body: unknown, source: SubmissionSource): DossierInput {
  const b = (body ?? {}) as Record<string, any>;
  const bagId = String(b.address?.bagId ?? "").trim();
  if (!BAG_ID.test(bagId)) throw new AppError(400, "Geen geldig adres gekozen");
  if (!b.topic) throw new AppError(400, "Geen onderwerp gekozen");
  const email = String(b.contact?.email ?? "").trim();
  if (!EMAIL.test(email)) throw new AppError(400, "Geen geldig e-mailadres");

  const claimed: any[] = Array.isArray(b.attachments) ? b.attachments.slice(0, 10) : [];
  const attachments = claimed.map((a) => {
    const key = String(a?.key ?? "");
    if (!key.startsWith(INTAKE_PREFIX) || key.includes("..")) throw new AppError(400, "Ongeldige bijlage");
    return {
      key,
      // The melder's file name is kept for a human to read, never for a path.
      name: String(a?.name ?? "").slice(0, 255),
      size: Math.max(0, Math.trunc(Number(a?.size ?? 0)) || 0),
      category: String(a?.category ?? "overig").slice(0, 64),
      // The file's type as the browser named it, when it is one we accept: the
      // old app's server dropped it, so artifact.mime_type stayed empty.
      mime: UPLOAD_TYPES.has(String(a?.mime ?? "")) ? String(a.mime) : null,
    };
  });

  const answers: Record<string, string> = {};
  if (b.answers && typeof b.answers === "object" && !Array.isArray(b.answers)) {
    for (const [k, v] of Object.entries(b.answers)) if (v !== null && v !== undefined) answers[k] = String(v);
  }

  const parsed = dossierSchema.safeParse({
    building: bagId,
    topic: String(b.topic),
    // The Dutch label as the melder read it: the wording of these topics has
    // changed before and will again, and a reviewer months later should see the
    // question that was actually put to the person.
    topicLabel: String(b.topicLabel ?? "").slice(0, 200),
    answers,
    attachments,
    contact: {
      type: b.contact?.type ?? null,
      name: String(b.contact?.name ?? "").slice(0, 200),
      email: email.slice(0, 320),
      phone: String(b.contact?.phone ?? "").slice(0, 40) || null,
      company: String(b.contact?.company ?? "").slice(0, 200) || null,
    },
    owner: b.owner === true,
    note: String(b.note ?? "").slice(0, 5000) || null,
    formVersion: String(b.formVersion ?? "").slice(0, 64),
    source: {
      submission: String(b.submissionId ?? ""),
      address: String(b.address?.label ?? ""),
      ip: source.ip,
      agent: source.agent?.slice(0, 300) ?? null,
      referrer: source.referrer?.slice(0, 300) ?? null,
    },
  });
  if (!parsed.success) throw new AppError(400, "De melding is niet compleet. Controleer de velden en probeer het opnieuw.");
  return parsed.data;
}
