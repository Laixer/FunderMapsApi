import { db } from "../db/client.ts";
import { dossierEntry } from "../db/schema/dataops.ts";

type Executor = Pick<typeof db, "insert">;

/**
 * Append one line to a dossier's timeline (§11.1). Never throws: the timeline
 * is narrative, and losing one line must not fail the action it narrates.
 * The structured fact (verdict, outcome, mail) is already stored by the caller.
 */
export async function addEntry(
  e: {
    dossierId: number;
    kind: "received" | "finding" | "verdict" | "remark" | "question" | "reply" | "status";
    actorKind: "melder" | "reviewer" | "pipeline" | "model" | "system";
    actor?: string | null;
    text: string;
    body?: Record<string, unknown>;
    verdictId?: number | null;
    visibleToMelder: boolean;
    /** Resend message id; the unique index on it deduplicates webhook replays. */
    mailMessageId?: string | null;
  },
  on: Executor = db,
): Promise<void> {
  try {
    await on.insert(dossierEntry).values({
      dossierId: e.dossierId,
      kind: e.kind,
      actorKind: e.actorKind,
      actor: e.actor ?? null,
      text: e.text,
      body: e.body ?? {},
      verdictId: e.verdictId ?? null,
      visibleToMelder: e.visibleToMelder,
      mailMessageId: e.mailMessageId ?? null,
    }).onConflictDoNothing();
  } catch (err) {
    console.error(`dossier_entry write failed (dossier ${e.dossierId}, ${e.kind}): ${String(err).slice(0, 200)}`);
  }
}
