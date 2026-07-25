/**
 * Recording and reading a dossier's trail.
 *
 * Status transitions are destructive: each one does a single `UPDATE ... SET
 * audit_status` and, until this module existed, kept no trace — so a dossier's
 * current position was knowable and its history was not. `update_date` is no
 * substitute, having been bulk-stamped by two migrations (2026-06-27 for
 * inquiries, 2026-03-07 for samples), so it records migrations, not people.
 *
 * Events are written **in the same transaction as the change they describe**.
 * A trail that silently misses entries when an insert fails is worse than no
 * trail, because it reads as authoritative. That makes
 * `sql/migrate/create_dossier_event.sql` a hard prerequisite for deploying this
 * — without the table, transitions fail loudly rather than drifting quietly.
 */

import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "../db/client.ts";
import { dossierEvent } from "../db/schema/report.ts";
import { user } from "../db/schema/application.ts";

/** Mirrors `report.dossier_event_kind`. */
export type DossierEventKind =
  | "created"
  | "submitted"
  | "approved"
  | "rejected"
  | "reopened"
  /** Arrived as a document rather than being typed (Data Ops pipeline). */
  | "imported"
  /** A field the pipeline filled in for a reviewer to confirm. */
  | "proposed";

/**
 * Which dossier the event is about. Exactly one key — the DB enforces it with a
 * CHECK, and the union makes "both" unrepresentable here rather than a 500.
 */
export type DossierSubject =
  | { inquiry: number }
  | { recovery: number }
  | { incident: string };

/** Anything with `.insert()` — `db` itself or a transaction handle. */
type Executor = Pick<typeof db, "insert">;

export interface RecordEventOptions {
  /** Null for machine actors: a pipeline step or a Windmill flow. */
  actor?: string | null;
  /** Human prose — a rejection motivation, an import source. */
  note?: string | null;
  /** Structured payload for machine-made events. */
  metadata?: Record<string, unknown> | null;
}

/**
 * Append one event.
 *
 * Pass the surrounding transaction as `on` so the event and the change it
 * describes commit together. Called outside a transaction it commits on its own,
 * which is right for events that describe something already durable (an upload,
 * an import).
 */
export async function recordEvent(
  subject: DossierSubject,
  kind: DossierEventKind,
  options: RecordEventOptions = {},
  on: Executor = db,
): Promise<void> {
  await on.insert(dossierEvent).values({
    kind,
    ...subject,
    actor: options.actor ?? null,
    note: options.note?.trim() || null,
    metadata: options.metadata ?? null,
  });
}

/** One trail entry as the API serves it. */
export interface LegacyDossierEvent {
  kind: DossierEventKind;
  date: string;
  /** Display name of who did it, or null for machine and deleted actors. */
  actorName: string | null;
  note: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Names are resolved here rather than snapshotted onto the event, so a user who
 * corrects their own name does not leave a trail of stale spellings. The cost is
 * a join and the loss of the name when an account is deleted — which the FK's
 * `ON DELETE SET NULL` makes explicit rather than silent.
 */
function displayName(row: {
  name: string | null;
  givenName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const full = [row.givenName, row.lastName].filter(Boolean).join(" ").trim();
  return row.name?.trim() || full || row.email;
}

/** A dossier's trail, oldest first — the order it happened in. */
export async function listEvents(
  subject: DossierSubject,
): Promise<LegacyDossierEvent[]> {
  // Match on the subject column *and* assert the others are null, so the
  // partial index for this dossier kind is the one that gets used.
  const where =
    "inquiry" in subject
      ? and(
          eq(dossierEvent.inquiry, subject.inquiry),
          isNull(dossierEvent.recovery),
        )
      : "recovery" in subject
        ? and(
            eq(dossierEvent.recovery, subject.recovery),
            isNull(dossierEvent.inquiry),
          )
        : and(
            eq(dossierEvent.incident, subject.incident),
            isNull(dossierEvent.inquiry),
          );

  const rows = await db
    .select({
      kind: dossierEvent.kind,
      createDate: dossierEvent.createDate,
      note: dossierEvent.note,
      metadata: dossierEvent.metadata,
      name: user.name,
      givenName: user.givenName,
      lastName: user.lastName,
      email: user.email,
    })
    .from(dossierEvent)
    .leftJoin(user, eq(user.id, dossierEvent.actor))
    .where(where)
    .orderBy(asc(dossierEvent.createDate), asc(dossierEvent.id));

  return rows.map((row) => ({
    kind: row.kind as DossierEventKind,
    date: row.createDate.toISOString(),
    actorName: row.email ? displayName(row as never) : null,
    note: row.note,
    metadata: row.metadata ?? null,
  }));
}
