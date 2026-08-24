import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { incident } from "../db/schema/report.ts";
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
 * with its own shared-secret check is easier to reason about and easier to
 * revoke.
 *
 * The form itself does the talking to a human. This layer only decides what is
 * safe to store and what shape it takes.
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
 * A melder picks a family, not one of eighteen database values.
 *
 * The narrow value is not guessed on their behalf: `wood` rather than
 * `wood_amsterdam`, because "houten palen" is genuinely all they told us, and a
 * reviewer inventing the difference later is worse than recording less.
 */
const FOUNDATION_GROUP: Record<string, string> = {
  houten_palen: "wood",
  houten_palen_oplanger: "wood_charger",
  op_staal: "no_pile",
  betonpalen: "concrete",
  overig: "other",
};

/** Topic to the `report.incident_question_type` enum. */
const QUESTION_TYPE: Record<string, string> = {
  foundationType: "research",
  recoveryType: "recovery",
  quickscan: "research",
  foundationResearch: "research",
  noDamage: "other",
  other: "other",
};

const attachmentSchema = z.object({
  key: z.string().min(1).max(512),
  name: z.string().max(255).default(""),
  size: z.number().int().nonnegative().default(0),
  category: z.string().max(64).default("overig"),
});

const incidentSchema = z.object({
  building: z.string().min(4).max(64),
  topic: z.string().min(1).max(64),
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
  source: z.record(z.string(), z.unknown()).default({}),
});

intake.post("/incident", zValidator("json", incidentSchema), async (c) => {
  const body = c.req.valid("json");

  // A melding about a building we cannot place is not a melding. Failing here
  // rather than storing a dangling row keeps the reviewer queue honest.
  const buildingId = await resolveToBuildingId(body.building);

  const foundationType = body.answers.foundationType
    ? (FOUNDATION_GROUP[body.answers.foundationType] ?? null)
    : null;

  /**
   * `document_file` holds object keys, and only object keys.
   *
   * Between 2020 and 2024 it did; somewhere in 2025 the portal started writing
   * the melder's original filename instead, and 238 attachments on 2025-2026
   * incidents can no longer be found in Spaces as a result. The readable record
   * — name, size, the melder's own category — goes to `metadata` alongside,
   * where losing it costs nothing.
   */
  const keys = body.attachments.map((a) => a.key);

  const metadata = {
    topic: body.topic,
    answers: body.answers,
    attachments: body.attachments,
    // Personal data, kept because there is nowhere else for it: the table has
    // no contact columns, and until 2026 these details existed only in an
    // email nobody kept. See the PR description for the retention question.
    contact: {
      ...body.contact,
      email: body.contact.email.trim().toLowerCase(),
    },
    note: body.note ?? null,
    source: body.source,
  };

  /**
   * `chained_building`, `foundation_recovery` and `neighbor_recovery` are set
   * explicitly rather than left to a column default. The Drizzle model says
   * they default to false; prod says NOT NULL with no default at all, and an
   * omitted column fails the insert outright. Drift, not preference.
   */
  const rows = await db
    .insert(incident)
    .values({
      // The meldcode is minted by the database, so the sequence stays the one
      // authority on what number comes next.
      id: sql`report.fir_generate_id(${env.INTAKE_CLIENT_ID})`,
      building: buildingId,
      foundationType,
      questionType: QUESTION_TYPE[body.topic] ?? "other",
      owner: body.owner,
      chainedBuilding: false,
      foundationRecovery: body.topic === "recoveryType",
      neighborRecovery: false,
      documentFile: keys,
      metadata,
    })
    .returning({ id: incident.id });

  const id = rows[0]?.id;
  if (!id) throw new AppError(500, "Incident not created");

  return c.json({ id }, 201);
});

/**
 * What the melder is told, and what we actually record.
 *
 * `pending_review` and `pending` are one word to a melder — someone is looking
 * at it. `discarded` is deliberately not surfaced as "weggegooid": a melding
 * that duplicates one we already hold is not a rejection of the person who
 * sent it.
 */
const STATE: Record<string, { state: string; explanation: string }> = {
  todo: {
    state: "ontvangen",
    explanation:
      "Uw melding staat in de wachtrij. Een beoordelaar bekijkt hem zo snel mogelijk.",
  },
  pending: {
    state: "in behandeling",
    explanation: "Een beoordelaar is met uw melding bezig.",
  },
  pending_review: {
    state: "in behandeling",
    explanation: "Een beoordelaar is met uw melding bezig.",
  },
  done: {
    state: "verwerkt",
    explanation:
      "Uw melding is verwerkt. De gegevens van dit pand zijn bijgewerkt.",
  },
  discarded: {
    state: "verwerkt",
    explanation:
      "Wij hebben uw melding bekeken. De gegevens waren al bij ons bekend, dus er is niets gewijzigd.",
  },
  rejected: {
    state: "afgewezen",
    explanation:
      "Wij konden uw melding niet verwerken. Neem contact met ons op als u denkt dat dit niet klopt.",
  },
};

const statusSchema = z.object({
  meldcode: z.string().regex(/^FIR\d{6}-\d+$/),
  email: z.email().max(320),
});

/**
 * One melding, by code plus the email that made it.
 *
 * Meldcodes come off a sequence, so `FIR012026-7263` is one increment from
 * somebody else's. The email is the actual credential, and both a wrong email
 * and a missing code return the same 404 — a distinguishable answer would turn
 * this into a way to enumerate which codes exist.
 */
intake.post("/status", zValidator("json", statusSchema), async (c) => {
  const { meldcode, email } = c.req.valid("json");

  const rows = await db.execute(sql`
    SELECT
      i.id,
      i.create_date,
      i.audit_status::text AS audit_status,
      coalesce(array_length(i.document_file, 1), 0) AS attachments,
      concat_ws(', ',
        nullif(concat_ws(' ', a.street, a.building_number), ''),
        nullif(concat_ws(' ', a.postal_code, a.city), '')
      ) AS address
    FROM report.incident i
    LEFT JOIN geocoder.address a ON a.building_id = i.building_id
    WHERE i.id = ${meldcode}
      AND i.delete_date IS NULL
      AND lower(i.metadata #>> '{contact,email}') = ${email.trim().toLowerCase()}
    ORDER BY a.id
    LIMIT 1
  `);

  const row = rows[0] as
    | {
        id: string;
        create_date: string;
        audit_status: string;
        attachments: number;
        address: string | null;
      }
    | undefined;

  if (!row) throw new NotFoundError();

  const mapped = STATE[row.audit_status] ?? STATE.todo!;

  return c.json({
    meldcode: row.id,
    address: row.address ?? "",
    received: new Date(row.create_date).toLocaleDateString("nl-NL", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
    state: mapped.state,
    explanation: mapped.explanation,
    attachments: Number(row.attachments),
  });
});

export default intake;
