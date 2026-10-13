import { ValidationError } from "./errors.ts";

export type AuditStatusTarget = "pending" | "pending_review" | "done" | "rejected" | "todo";

/**
 * The states in which a rapportage or herstel can still be written to. One
 * list for "may edit" and "may offer for review": a record someone can still
 * change is a record they can hand over, which is what the Studio promises.
 */
export const WRITABLE_STATES: readonly string[] = ["todo", "pending", "rejected"];

// From which states each target may be reached. `pending` is reachable from
// anywhere (reset, first sample, an edit after a rejection).
const ALLOWED_FROM: Record<Exclude<AuditStatusTarget, "pending">, readonly string[]> = {
  // Was `pending` only: offering a rapportage straight after a rejection, or
  // one nobody had saved a sample on yet, answered "Illegal audit-status
  // transition" although the record was open for editing. The reviewer can
  // still send it back.
  pending_review: WRITABLE_STATES,
  done: ["pending_review"],
  rejected: ["pending_review"],
  todo: ["pending"],
};

/** Returns the new audit status, or throws a 400 when the move is not allowed. */
export function transitionStatus(current: string | null, target: AuditStatusTarget): string {
  const cur = current ?? "todo";
  if (target !== "pending" && !ALLOWED_FROM[target].includes(cur)) {
    throw new ValidationError([`Illegal audit-status transition: ${cur} → ${target}`]);
  }
  return target;
}
