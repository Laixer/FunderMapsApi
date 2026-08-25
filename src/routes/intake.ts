import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dossier, artifact } from "../db/schema/dataops.ts";
import { env } from "../config.ts";
import { resolveToBuildingId } from "../services/geocoder.ts";
import { AppError, NotFoundError } from "../lib/errors.ts";
import { timingSafeEqual } from "node:crypto";

/**
 * The public intake lane.
 *
 * Everything here arrives from the terugmeldformulier — an unauthenticated
 * stranger on a phone — so it is deliberately kept out of `/api/incident`,
 * which sits behind `authMiddleware`. Carving an exception inside an
 * already-authenticated prefix is how auth holes get made; a separate mount
 * with its own shared-secret check is easier to reason about and to revoke.
 *
 * **A submission becomes a dossier, not an incident.** Four of the form's six
 * topics deliver a document — archive drawing, QuickScan, funderingsonderzoek,
 * herstelbewijs — and only two are meldingen. Writing them all to
 * `report.incident` would both misname them and strand them: nothing consumes
 * that table. `dataops.dossier` resolves to an incident, a report or a recovery
 * at review time, which is where that decision belongs
 * (docs/dataops-pipeline.md §3.1).
 */
const intake = new Hono();

/** The shared secret the intake app presents. Nothing else may use this lane. */
intake.use("*", async (c, next) => {
  if (!env.INTAKE_TOKEN) throw new AppError(503, "Intake is not configured");
  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Length-independent compare; `timingSafeEqual` needs equal-length inputs.
  const ok =
    presented.length === env.INTAKE_TOKEN.length &&
    timingSafeEqual(
      new TextEncoder().encode(presented),
      new TextEncoder().encode(env.INTAKE_TOKEN),
    );
  if (!ok) throw new AppError(401, "Unauthorized");
  await next();
});

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

const dossierSchema = z.object({
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

intake.post("/dossier", zValidator("json", dossierSchema), async (c) => {
  const body = c.req.valid("json");

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

  return c.json({ reference: created.reference }, 201);
});

/**
 * What the melder is told, and what we actually record.
 *
 * A dossier with no outcome yet is "ontvangen" or "in behandeling" depending on
 * whether anything has been committed. `duplicate` is deliberately not surfaced
 * as a rejection: a delivery we already hold is not a fault of the person who
 * sent it, and telling them otherwise would discourage exactly the behaviour we
 * want.
 */
function describe(
  outcome: string | null,
  note: string | null,
  hasInquiry: boolean,
): { state: string; explanation: string } {
  switch (outcome) {
    case "accepted":
      return {
        state: "verwerkt",
        explanation:
          note ??
          "Uw melding is verwerkt. De gegevens van dit pand zijn bijgewerkt.",
      };
    case "duplicate":
      return {
        state: "verwerkt",
        explanation:
          note ??
          "Wij hebben uw melding bekeken. Deze gegevens waren al bij ons bekend, dus er is niets gewijzigd.",
      };
    case "rejected":
      return {
        state: "afgewezen",
        explanation:
          note ??
          "Wij konden uw melding niet verwerken. Neem contact met ons op als u denkt dat dit niet klopt.",
      };
    default:
      return hasInquiry
        ? {
            state: "in behandeling",
            explanation: "Een beoordelaar is met uw melding bezig.",
          }
        : {
            state: "ontvangen",
            explanation:
              "Uw melding staat in de wachtrij. Een beoordelaar bekijkt hem zo snel mogelijk.",
          };
  }
}

const statusSchema = z.object({
  reference: z.string().regex(/^FM\d{4}-\d{6}$/),
  email: z.email().max(320),
});

/**
 * One submission, by reference plus the email that made it.
 *
 * References come off a sequence, so `FM2026-000042` is one increment from
 * somebody else's. The email is the actual credential, and both a wrong email
 * and a missing reference return the same 404 — a distinguishable answer would
 * turn this into a way to enumerate which submissions exist.
 */
intake.post("/status", zValidator("json", statusSchema), async (c) => {
  const { reference, email } = c.req.valid("json");

  const rows = await db.execute(sql`
    SELECT
      d.reference,
      d.created_at,
      d.outcome::text AS outcome,
      d.outcome_note,
      d.inquiry_id,
      (SELECT count(*) FROM dataops.artifact a WHERE a.dossier_id = d.id) AS attachments,
      concat_ws(', ',
        nullif(concat_ws(' ', ga.street, ga.building_number), ''),
        nullif(concat_ws(' ', ga.postal_code, ga.city), '')
      ) AS address
    FROM dataops.dossier d
    LEFT JOIN geocoder.address ga ON ga.building_id = d.building_id
    WHERE d.reference = ${reference}
      AND lower(d.submitter ->> 'email') = ${email.trim().toLowerCase()}
    ORDER BY ga.id
    LIMIT 1
  `);

  const row = rows[0] as
    | {
        reference: string;
        created_at: string;
        outcome: string | null;
        outcome_note: string | null;
        inquiry_id: number | null;
        attachments: number;
        address: string | null;
      }
    | undefined;

  if (!row) throw new NotFoundError();

  const { state, explanation } = describe(
    row.outcome,
    row.outcome_note,
    row.inquiry_id !== null,
  );

  return c.json({
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
  });
});

export default intake;
