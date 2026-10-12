import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dossier } from "../db/schema/dataops.ts";
import { addEntry } from "./dossier-entries.ts";
import { sendDossierReceivedMail } from "./intake-emails.ts";
import { ingestDossierNow } from "./windmill.ts";

/**
 * The vervolgmelding: new evidence on a melding that is already closed.
 *
 * Melders reply to the closing mail with what we asked for, or with what
 * proves us wrong: a funderingsonderzoek, a drawing. Since API #230 those
 * files were stored, but on the closed dossier, where nobody reviews them and
 * nothing reopens it. Don, 2026-10-12: "ik verwacht een structurele
 * oplossing". The files go on a new dossier that points back at the old one,
 * so they enter the normal review queue and the closed outcome stays what it
 * was. The link is `payload.follow_up_of`, not `duplicate_of`: this is a
 * continuation, not the same submission twice.
 */

type Executor = Pick<typeof db, "insert" | "select">;

/** What a follow-up copies from the dossier it continues. */
export interface FollowUpSource {
  id: number;
  reference: string | null;
  outcome: string | null;
  inquiryId: number | null;
  bagId: string | null;
  buildingId: string | null;
  resolutionStatus: string | null;
  submitter: Record<string, unknown> | null;
}

export interface FollowUpRef {
  id: number;
  reference: string;
}

/** Closed = an outcome was recorded or it was committed into an inquiry; the same test as the queue's onDesk. */
export function isClosed(head: { outcome: string | null; inquiryId: number | null }): boolean {
  return Boolean(head.outcome) || head.inquiryId !== null;
}

/** The old meldcode as the timeline and the subject name it. */
export function sourceLabel(source: Pick<FollowUpSource, "id" | "reference">): string {
  return source.reference ?? `melding ${source.id}`;
}

/** Subject and payload of the new dossier. Pure, for the tests. */
export function followUpValues(source: Pick<FollowUpSource, "id" | "reference">, note: string | null) {
  return {
    subject: `Aanvullende stukken bij ${sourceLabel(source)}`,
    payload: {
      topic: "follow_up",
      topicLabel: "Aanvullende stukken",
      // The reply as the melder wrote it, quoted history included; the intake
      // form's note is capped at the same length.
      note: note?.trim() ? note.trim().slice(0, 5000) : null,
      source: "reply",
      follow_up_of: { dossier_id: source.id, reference: source.reference },
    },
  };
}

export async function loadFollowUpSource(dossierId: number, on: Executor = db): Promise<FollowUpSource | null> {
  const [head] = await on
    .select({
      id: dossier.id,
      reference: dossier.reference,
      outcome: dossier.outcome,
      inquiryId: dossier.inquiryId,
      bagId: dossier.bagId,
      buildingId: dossier.buildingId,
      resolutionStatus: dossier.resolutionStatus,
      submitter: dossier.submitter,
    })
    .from(dossier)
    .where(eq(dossier.id, dossierId))
    .limit(1);
  return head ?? null;
}

/**
 * Insert the follow-up dossier. Same conventions as the intake POST
 * (routes/intake.ts): channel 'upload', reference minted by the database.
 * Takes a transaction so the caller can put the documents in with it; the
 * timeline, the mail and the read come after the commit (finishFollowUp).
 */
export async function createFollowUpDossier(
  on: Executor,
  source: FollowUpSource,
  opts: { note?: string | null } = {},
): Promise<FollowUpRef> {
  const { subject, payload } = followUpValues(source, opts.note ?? null);
  const [row] = await on
    .insert(dossier)
    .values({
      channel: "upload",
      subject,
      reference: sql`dataops.generate_reference()`,
      bagId: source.bagId,
      buildingId: source.buildingId,
      resolutionStatus: source.resolutionStatus,
      submitter: source.submitter,
      payload,
    })
    .returning({ id: dossier.id, reference: dossier.reference });
  if (!row?.reference) throw new Error(`follow-up of dossier ${source.id} not created`);
  return { id: row.id, reference: row.reference };
}

/**
 * After the commit, with the documents on the new dossier: both timelines,
 * the ontvangstbevestiging with the new meldcode (it lists the files, so it
 * waits for them), and the read. Never throws; every step below is fail-soft.
 */
export async function finishFollowUp(
  source: FollowUpSource,
  created: FollowUpRef,
  by: { actorKind: "system" | "reviewer"; actor?: string | null },
): Promise<void> {
  const link = { dossier_id: created.id, reference: created.reference };
  await addEntry({
    dossierId: created.id,
    kind: "received", actorKind: "melder", actor: "reply",
    text: `Melding ${created.reference} ontvangen`,
    visibleToMelder: true,
  });
  await addEntry({
    dossierId: created.id,
    kind: "status", ...by,
    text: `Vervolg op ${sourceLabel(source)}: stukken ontvangen na afronding`,
    body: { follow_up_of: { dossier_id: source.id, reference: source.reference } },
    visibleToMelder: false,
  });
  await addEntry({
    dossierId: source.id,
    kind: "status", ...by,
    text: `Nieuwe stukken ontvangen na afronding → vervolgmelding ${created.reference}`,
    body: { follow_up: link },
    visibleToMelder: false,
  });
  await sendDossierReceivedMail(created.id);
  await ingestDossierNow(created.id);
}
