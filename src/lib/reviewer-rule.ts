// Who may be named reviewer on a report's attribution, checked without
// touching config or the database so it can be tested on its own.

import { ForbiddenError } from "./errors.ts";

// Ids arrive from a request body (z.uuid() accepts either case) and from the
// database (always lowercase).
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The reviewer is never the report's creator — that is `creator_reviewer_chk`
 * on `application.attribution`. Checked here so it is a 403, not a 500.
 *
 * On a create the creator IS the caller, so nobody names themselves reviewer
 * of a report they make. On an update the stored creator counts: a colleague
 * may edit a report somebody else made, and naming that somebody as reviewer
 * would die on the constraint. The editor may be the reviewer: until
 * 2026-10-26 they could not, so the reviewer of a rapportage (whoever
 * committed it in the review lane) could not save an edit of it, not even one
 * that changed nothing (API #245; Yorick 2026-10-26).
 */
export function assertReviewerAllowed(reviewer: string, creator: string): void {
  if (same(reviewer, creator)) {
    throw new ForbiddenError("Reviewer must differ from creator");
  }
}
