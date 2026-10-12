// Who may be named reviewer on a report's attribution, checked without
// touching config or the database so it can be tested on its own.

import { ForbiddenError } from "./errors.ts";

// Ids arrive from a request body (z.uuid() accepts either case) and from the
// database (always lowercase).
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The reviewer is never the report's creator — that is `creator_reviewer_chk`
 * on `application.attribution` — and never the user making the change.
 *
 * On a create the creator IS the caller, so the two rules are one. On an
 * update they are not: a colleague may edit a report somebody else made, and
 * naming that somebody as reviewer passes a caller-only check and then dies on
 * the constraint as a 500. Pass the stored creator there.
 */
export function assertReviewerAllowed(reviewer: string, creator: string, caller: string): void {
  if (same(reviewer, creator)) {
    throw new ForbiddenError("Reviewer must differ from creator");
  }
  if (same(reviewer, caller)) {
    throw new ForbiddenError("Reviewer must differ from the user making the change");
  }
}
