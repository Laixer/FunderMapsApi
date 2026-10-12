import { env } from "../config.ts";
import { db } from "../db/client.ts";
import { artifact } from "../db/schema/dataops.ts";
import { addEntry } from "./dossier-entries.ts";
import { createFollowUpDossier, finishFollowUp, isClosed, loadFollowUpSource, type FollowUpRef } from "./follow-up-dossier.ts";
import { ALLOWED_UPLOAD_MIMES, MAX_UPLOAD_BYTES, putObject, uniqueFileName } from "./s3.ts";
import { ingestDossierNow } from "./windmill.ts";

/**
 * Files a melder sends as a reply to our mail (API #230).
 *
 * Until 2026-10-08 the webhook kept only the text and noted
 * "[n bijlage(n) — nog niet opgeslagen]": 25 replies with attachments since
 * 2026-09-07, none of them in their melding, among them foundation reports a
 * reviewer then asked for again. Don: "ik wil een oplossing voor de toekomst".
 *
 * Each attachment is fetched from Resend (the received email's attachment
 * list carries a signed download URL), stored under dataops/ like an upload
 * and added to the melding as a document; an open melding is then read at
 * once, a closed one gets a vervolgmelding that holds the files. Left out: inline images and small pictures (mail logos and
 * signatures), and anything the upload whitelist would refuse (a forwarded
 * .eml, for one). What was stored and what was left out goes on the timeline.
 */

export interface ResendAttachment {
  id: string;
  filename: string;
  content_type: string;
  content_disposition?: string | null;
  content_id?: string | null;
  size: number;
  download_url?: string;
}

/** Below this an image is a logo or a signature, not a document (the logos seen so far: 22 kB). */
const SMALL_IMAGE_BYTES = 60_000;

/** Which attachments become documents, and why the rest do not. Pure, for the tests. */
export function sortAttachments(list: ResendAttachment[]): { keep: ResendAttachment[]; skipped: { name: string; why: string }[] } {
  const keep: ResendAttachment[] = [];
  const skipped: { name: string; why: string }[] = [];
  for (const a of list) {
    const mime = (a.content_type || "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    if (mime.startsWith("image/") && (a.content_disposition === "inline" || a.size < SMALL_IMAGE_BYTES)) {
      skipped.push({ name: a.filename, why: "afbeelding in de mail (logo of handtekening)" });
    } else if (!ALLOWED_UPLOAD_MIMES.has(mime)) {
      skipped.push({ name: a.filename, why: `soort bestand niet toegestaan (${mime})` });
    } else if (a.size > MAX_UPLOAD_BYTES) {
      skipped.push({ name: a.filename, why: "te groot" });
    } else if (a.size === 0) {
      skipped.push({ name: a.filename, why: "leeg" });
    } else {
      keep.push(a);
    }
  }
  return { keep, skipped };
}

async function resend<T>(path: string): Promise<T> {
  const r = await fetch(`https://api.resend.com/${path}`, {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`resend ${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

/**
 * Store the attachments of one received email on its dossier. Never throws:
 * the reply itself is already on the timeline, and a failure is logged there
 * too, so a reviewer knows to ask for the file.
 *
 * On a closed dossier the files become a vervolgmelding (Don, 2026-10-12;
 * lib/follow-up-dossier.ts): a new dossier in the review queue, and a line
 * on the closed one pointing at it. `replyText` is its note. Only when
 * something was actually stored; a mail logo alone opens nothing.
 */
export async function storeReplyAttachments(dossierId: number, emailId: string, replyText: string | null = null): Promise<void> {
  try {
    const source = await loadFollowUpSource(dossierId);
    if (!source) return;
    const list = (await resend<{ data?: ResendAttachment[] }>(`emails/receiving/${emailId}/attachments`)).data ?? [];
    const { keep, skipped } = sortAttachments(list);
    // Bytes first, rows after: the target dossier is only known once there
    // is something to put in it.
    const fetched: { name: string; key: string; mime: string; size: number }[] = [];
    for (const a of keep) {
      if (!a.download_url) { skipped.push({ name: a.filename, why: "geen downloadlink" }); continue; }
      const file = await fetch(a.download_url, { signal: AbortSignal.timeout(120_000) });
      if (!file.ok) { skipped.push({ name: a.filename, why: `ophalen mislukt (HTTP ${file.status})` }); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = a.content_type.split(";")[0]!.trim().toLowerCase();
      const key = `dataops/${uniqueFileName(a.filename, mime)}`;
      await putObject(key, bytes, mime);
      fetched.push({ name: a.filename, key, mime, size: bytes.byteLength });
    }

    const closed = isClosed(source);
    const { stored, followUp } = await db.transaction(async (tx) => {
      if (!fetched.length) return { stored: [], followUp: null };
      const followUp: FollowUpRef | null = closed ? await createFollowUpDossier(tx, source, { note: replyText }) : null;
      const rows = await tx
        .insert(artifact)
        .values(fetched.map((f) => ({ dossierId: followUp?.id ?? dossierId, storageKey: f.key, originalFilename: f.name, mimeType: f.mime, sizeBytes: f.size, declaredCategory: null, lane: "none" })))
        .returning({ id: artifact.id });
      return { stored: rows.map((r, i) => ({ id: r.id, name: fetched[i]!.name })), followUp };
    });
    const target = followUp?.id ?? dossierId;

    if (stored.length || skipped.length) {
      const lines = [
        stored.length ? `Bijlage${stored.length === 1 ? "" : "n"} uit het antwoord opgeslagen: ${stored.map((s) => s.name).join(", ")}` : null,
        skipped.length ? `Niet opgeslagen: ${skipped.map((s) => `${s.name} (${s.why})`).join(", ")}` : null,
      ].filter(Boolean);
      await addEntry({
        dossierId: target, kind: "status", actorKind: "system",
        text: lines.join("\n"),
        body: { email_id: emailId, artifact_ids: stored.map((s) => s.id), skipped },
        visibleToMelder: false,
      });
    }
    if (followUp) await finishFollowUp(source, followUp, { actorKind: "system" });
    else if (stored.length && !closed) await ingestDossierNow(dossierId);
  } catch (err) {
    console.error(`reply attachments for dossier ${dossierId} (email ${emailId}) failed:`, err);
    await addEntry({
      dossierId, kind: "status", actorKind: "system",
      text: "De bijlagen van een antwoord konden niet worden opgeslagen; vraag de melder het bestand via een nieuwe melding te sturen.",
      body: { email_id: emailId, error: String(err).slice(0, 300) },
      visibleToMelder: false,
    }).catch(() => {});
  }
}
