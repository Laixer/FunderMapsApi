import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dossier, artifact } from "../db/schema/dataops.ts";
import { resolveToBuildingId } from "../services/geocoder.ts";
import { AppError } from "./errors.ts";
import { describeOutcome } from "./intake-outcome.ts";
import { sendDossierReceivedMail } from "./intake-emails.ts";
import { currentBasis, currentRisk, explainBasis } from "./intake-risk-followup.ts";
import { riskLabelIn } from "./intake-emails.ts";
import { addEntry } from "./dossier-entries.ts";

// A submission from the melden portal becoming a dossier, and looking one up
// again. Shared by the two lanes into it: the token lane routes/intake.ts (the
// old melden app, until it is gone) and the public routes/submission.ts (the
// portal inside the Studio app, 2026-10-30). Moved here from routes/intake.ts
// unchanged.

/**
 * What the melder said they were delivering.
 *
 * Kept as their claim, never promoted to a finding. A file labelled `quickscan`
 * is what stops the pipeline reading a foundation type back off our own data —
 * a QuickScan states a type it took from FunderMaps, so accepting it would be a
 * loop. That is the single most valuable thing this form records, and it is
 * only ever a hint about what to do with the document, not an answer.
 */
const attachmentSchema = z.object({
  key: z.string().min(1).max(512),
  name: z.string().max(255).default(""),
  size: z.number().int().nonnegative().default(0),
  category: z.string().max(64).default("overig"),
  mime: z.string().max(128).nullish(),
});

export const dossierSchema = z.object({
  building: z.string().min(4).max(64),
  topic: z.string().min(1).max(64),
  topicLabel: z.string().max(200).default(""),
  answers: z.record(z.string(), z.string()).default({}),
  attachments: z.array(attachmentSchema).max(10).default([]),
  contact: z.object({
    type: z.string().max(32).nullish(),
    name: z.string().max(200).default(""),
    email: z.email().max(320),
    phone: z.string().max(40).nullish(),
    company: z.string().max(200).nullish(),
  }),
  owner: z.boolean().default(false),
  note: z.string().max(5000).nullish(),
  formVersion: z.string().max(64).default(""),
  source: z.record(z.string(), z.unknown()).default({}),
});
export type DossierInput = z.infer<typeof dossierSchema>;

export const statusSchema = z.object({
  reference: z.string().regex(/^FM\d{4}-\d{6}$/),
  email: z.email().max(320),
});

/**
 * A submission becomes a dossier, not an incident: four of the form's six
 * topics deliver a document, and which of the two a submission becomes is a
 * reviewer's call at commit time (docs/dataops-pipeline.md §3.1).
 */
export async function createDossier(body: DossierInput): Promise<{ reference: string }> {
  /**
   * Stage 4 (RESOLVE), answered before a document is opened.
   *
   * The melder named the building, which is better evidence than anything the
   * pipeline can derive from a scan. A failure here is recorded rather than
   * thrown: BAG import freshness is a known failure mode (issue #992), and
   * losing a submission because our own copy of the BAG is a week stale would
   * be the worst possible trade. The dossier lands with `stale_bag` and a
   * reviewer sorts it out.
   */
  let buildingId: string | null = null;
  let resolutionStatus = "resolved";
  try {
    buildingId = await resolveToBuildingId(body.building);
  } catch {
    resolutionStatus = "stale_bag";
  }

  const submitter = {
    ...body.contact,
    email: body.contact.email.trim().toLowerCase(),
    isOwner: body.owner,
  };

  const payload = {
    topic: body.topic,
    topicLabel: body.topicLabel || null,
    answers: body.answers,
    note: body.note ?? null,
    formVersion: body.formVersion || null,
    source: body.source,
  };

  const created = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(dossier)
      .values({
        channel: "upload",
        // What a reviewer sees first in the queue.
        subject: body.topicLabel || body.topic,
        // Minted by the database, so the sequence stays the one authority.
        reference: sql`dataops.generate_reference()`,
        bagId: body.building,
        buildingId,
        resolutionStatus,
        submitter,
        payload,
      })
      .returning({ id: dossier.id, reference: dossier.reference });

    const head = rows[0];
    if (!head?.reference) throw new AppError(500, "Dossier not created");

    if (body.attachments.length > 0) {
      await tx.insert(artifact).values(
        body.attachments.map((a) => ({
          dossierId: head.id,
          storageKey: a.key,
          originalFilename: a.name || null,
          mimeType: a.mime ?? null,
          sizeBytes: a.size,
          // Kept per file, because one delivery can carry a funderingsonderzoek
          // and a QuickScan and they are not admissible to the same degree.
          // This is what stops the pipeline reading a foundation type back off
          // our own data.
          declaredCategory: a.category,
          // The lane is chosen from the document, not from what the melder
          // called it — 42 of 160 `foundation_research` files are scans. The
          // ingest worker decides; until it runs, nothing is claimed.
          lane: "none",
        })),
      );
    }

    return head;
  });

  // Moment 1 of tracker #1020: the ontvangstbevestiging. After the commit, so
  // the meldcode it quotes is real; before the answer, so a failure is logged in
  // the context of this request. Fail-soft -- the helper never throws.
  await addEntry({
    dossierId: created.id,
    kind: "received", actorKind: "melder", actor: "upload",
    text: `Melding ${created.reference} ontvangen`,
    visibleToMelder: true,
  });
  await sendDossierReceivedMail(created.id);

  // Checked inside the transaction (no reference = 500 before the commit).
  return { reference: created.reference as string };
}

export interface DossierStatus {
  reference: string;
  address: string;
  received: string;
  state: string;
  explanation: string;
  attachments: number;
  risk: string[];
}

/**
 * One submission, by reference plus the email that made it; null when either
 * half is wrong.
 *
 * References come off a sequence, so `FM2026-000042` is one increment from
 * somebody else's. The email is the actual credential, and the callers answer
 * a wrong email and a missing reference with the same 404 — a distinguishable
 * answer would turn this into a way to enumerate which submissions exist.
 */
export async function lookupDossier(reference: string, email: string): Promise<DossierStatus | null> {
  const rows = await db.execute(sql`
    SELECT
      d.reference,
      d.created_at,
      d.outcome::text AS outcome,
      d.outcome_note,
      d.inquiry_id,
      d.building_id,
      (SELECT count(*) FROM dataops.artifact a WHERE a.dossier_id = d.id) AS attachments,
      concat_ws(', ',
        nullif(concat_ws(' ', ga.street, ga.building_number), ''),
        nullif(concat_ws(' ', ga.postal_code, ga.city), '')
      ) AS address
    FROM dataops.dossier d
    -- The address the melder submitted wins over the building's first-registered
    -- one (#200): a pand with several front doors would otherwise show a
    -- neighbour here, and this page is linked from the mail that names it.
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN d.bag_id IS NULL THEN NULL
               WHEN d.bag_id LIKE 'NL.IMBAG.%' THEN d.bag_id
               ELSE 'NL.IMBAG.NUMMERAANDUIDING.' || d.bag_id
             END AS nummeraanduiding
    ) n
    LEFT JOIN LATERAL (
      SELECT a.street, a.building_number, a.postal_code, a.city
        FROM geocoder.address a
       WHERE a.external_id = n.nummeraanduiding
          OR a.building_id = d.building_id
       ORDER BY (a.external_id = n.nummeraanduiding) DESC NULLS LAST, a.external_id
       LIMIT 1
    ) ga ON TRUE
    WHERE d.reference = ${reference}
      AND lower(d.submitter ->> 'email') = ${email.trim().toLowerCase()}
    LIMIT 1
  `);

  const row = rows[0] as
    | {
        reference: string;
        created_at: string;
        outcome: string | null;
        outcome_note: string | null;
        inquiry_id: number | null;
        building_id: string | null;
        attachments: number;
        address: string | null;
      }
    | undefined;

  if (!row) return null;

  const { state, explanation } = describeOutcome(
    row.outcome,
    row.outcome_note,
    row.inquiry_id !== null,
  );

  // The risk as registered right now (Don, 2026-10-02: the most common reply
  // was "waar zie ik het nieuwe risico?"). Same words as the follow-up mail.
  let risk: string[] = [];
  if (row.building_id) {
    const r = (await currentRisk([row.building_id])).get(row.building_id) ?? null;
    if (r) {
      const basis = (await currentBasis([row.building_id])).get(row.building_id) ?? null;
      risk = [
        `Droogstand: ${riskLabelIn(r, r.drystand)}`,
        `Ontwateringsdiepte: ${riskLabelIn(r, r.dewateringDepth)}`,
        `Bacteriële aantasting: ${riskLabelIn(r, r.bioInfection)}`,
        ...explainBasis(basis),
      ];
    }
  }

  return {
    reference: row.reference,
    address: row.address ?? "",
    received: new Date(row.created_at).toLocaleDateString("nl-NL", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
    state,
    explanation,
    attachments: Number(row.attachments),
    risk,
  };
}
