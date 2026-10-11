// Work packages per colleague (dataops.work_package_assignment), validated
// without touching config or the database so it can be tested on its own.
//
// A work package is a named filter on the review queue, defined by the Studio
// (WORK_PACKAGES in its src/services/workPackages.ts). The API does not know
// that list and should not: a package added to the Studio must not need an API
// release before the admin can hand it out. What the API guards is the shape,
// the same pattern the table's CHECK enforces, so a bad id is a 400 here
// instead of a constraint violation (500) on insert.

export const PACKAGE_ID = /^[a-z0-9-]{1,64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Far more than the Studio defines (11 on 2026-10-09); a bound, not a quota. */
export const MAX_PACKAGES = 50;

/**
 * Every problem with a PUT body at once, the way the Studio can show them.
 * Duplicates are not an error: the set is a set, `normalizePackageIds` folds
 * them, and rejecting a double click would only annoy.
 */
export function validateWorkPackageBody(body: unknown): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return ["body must be an object with packageIds"];
  const ids = (body as { packageIds?: unknown }).packageIds;
  if (!Array.isArray(ids)) return ["packageIds must be an array of work package ids"];
  const errors: string[] = [];
  if (ids.length > MAX_PACKAGES) errors.push(`packageIds may hold at most ${MAX_PACKAGES} ids`);
  ids.forEach((id, i) => {
    if (typeof id !== "string" || !PACKAGE_ID.test(id)) errors.push(`packageIds[${i}] must match ${PACKAGE_ID.source}`);
  });
  return errors;
}

/** The validated ids, deduplicated and sorted so the response is stable. */
export function normalizePackageIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Rows (one per user and package) folded into one entry per user, ids sorted. */
export function groupAssignments(rows: { userId: string; packageId: string }[]): { userId: string; packageIds: string[] }[] {
  const byUser = new Map<string, string[]>();
  for (const r of rows) {
    const ids = byUser.get(r.userId);
    if (ids) ids.push(r.packageId);
    else byUser.set(r.userId, [r.packageId]);
  }
  return [...byUser].map(([userId, ids]) => ({ userId, packageIds: ids.sort() }));
}
