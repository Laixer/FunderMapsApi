import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { workPackageAssignment } from "../../db/schema/dataops.ts";
import { organizationUser } from "../../db/schema/application.ts";
import { env } from "../../config.ts";
import { ValidationError } from "../../lib/errors.ts";
import { groupAssignments, normalizePackageIds, UUID, validateWorkPackageBody } from "../../lib/work-packages.ts";
import type { AppEnv } from "../../types/context.ts";

/**
 * The admin composes each colleague's work packages (the Studio's Vandaag).
 *
 * Until 2026-10-09 every reviewer ticked their own packages, kept in that
 * browser only: another computer started empty, and the admin handed work out
 * by telling people what to tick. The admin asked to set them per colleague,
 * so they show up on any computer. The colleague reads their own set through
 * GET /api/dataops/work-packages/me; this file is the admin side.
 *
 * Package ids belong to the Studio (lib/work-packages.ts says why the API
 * only checks their shape).
 */
const workPackages = new Hono<AppEnv>();

// GET /api/management/work-packages
//   Every user who has a set, one entry each. Users without one are absent:
//   they choose their own packages.
workPackages.get("/", async (c) => {
  const rows = await db
    .select({ userId: workPackageAssignment.userId, packageId: workPackageAssignment.packageId })
    .from(workPackageAssignment)
    .orderBy(asc(workPackageAssignment.userId), asc(workPackageAssignment.packageId));
  return c.json({ assignments: groupAssignments(rows) });
});

// PUT /api/management/work-packages/:userId  { packageIds: string[] }
//   Replaces the user's set as a whole; [] clears it, and the user is back to
//   choosing their own. Only staff (members of the platform organisation) can
//   hold a set: the review queue the packages filter is staff-only, so a set
//   on anyone else would be a list of filters they get a 403 on.
workPackages.put("/:userId", async (c) => {
  const admin = c.get("user");
  const userId = c.req.param("userId");
  if (!UUID.test(userId)) throw new ValidationError(["userId must be a user id"]);

  const body = await c.req.json().catch(() => null);
  const errors = validateWorkPackageBody(body);
  if (errors.length > 0) throw new ValidationError(errors);
  const packageIds = normalizePackageIds((body as { packageIds: string[] }).packageIds);

  const [member] = await db
    .select({ userId: organizationUser.userId })
    .from(organizationUser)
    .where(and(eq(organizationUser.userId, userId), eq(organizationUser.organizationId, env.PLATFORM_ORGANIZATION_ID)))
    .limit(1);
  if (!member) throw new ValidationError(["userId is not a staff member"]);

  // Delete + insert in one transaction: a reader never sees half a set, and
  // assigned_at/assigned_by describe the set as it was saved, every row alike.
  await db.transaction(async (tx) => {
    await tx.delete(workPackageAssignment).where(eq(workPackageAssignment.userId, userId));
    if (packageIds.length > 0) {
      const now = new Date();
      await tx
        .insert(workPackageAssignment)
        .values(packageIds.map((packageId) => ({ userId, packageId, assignedBy: admin.id, assignedAt: now })));
    }
  });

  return c.json({ userId, packageIds });
});

export default workPackages;
