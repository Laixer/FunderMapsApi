import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { staffCapacity } from "../../db/schema/dataops.ts";
import { organizationUser, user as appUser } from "../../db/schema/application.ts";
import { env } from "../../config.ts";
import { NotFoundError, ValidationError } from "../../lib/errors.ts";
import { personName } from "../../lib/person-name.ts";
import { KINDS } from "../../lib/queue-sql.ts";
import { UUID } from "../../lib/work-packages.ts";
import {
  dailyTarget,
  ITEMS_PER_HOUR,
  normalizeCapacity,
  STALE_WORKING_DAYS,
  validateCapacityBody,
  type CapacityBody,
  type Mode,
} from "../../lib/dispatch.ts";
import { bucketSizes, holdingsPerPerson, lastDispatchAt, runDispatch } from "../../lib/dispatch-run.ts";
import type { AppEnv } from "../../types/context.ts";

/**
 * The admin side of the dispatcher (#277), Beheer › Werkverdeling: who takes
 * how much review-queue work (dataops.staff_capacity), what everyone holds
 * now, what waits in each bucket, and a preview or run of the dispatcher.
 * Hours per person are staff data: administrators only (the management guard).
 */
const capacity = new Hono<AppEnv>();
const MODES = new Set<Mode>(["new", "drip", "all"]);

// GET /api/management/capacity
//   Every staff member (platform organisation), with their capacity row or
//   null (= the dispatcher gives them nothing), their day's target, what they
//   hold per bucket, what they closed this week; plus the buckets, the rules'
//   constants, the document kinds a preference may name, and the last run.
capacity.get("/", async (c) => {
  const [staff, rows, holdings, buckets, lastRun] = await Promise.all([
    db
      .select({ userId: appUser.id, name: appUser.name, givenName: appUser.givenName, lastName: appUser.lastName, email: appUser.email, role: organizationUser.role })
      .from(organizationUser)
      .innerJoin(appUser, eq(appUser.id, organizationUser.userId))
      .where(eq(organizationUser.organizationId, env.PLATFORM_ORGANIZATION_ID)),
    db.select().from(staffCapacity).orderBy(asc(staffCapacity.userId)),
    holdingsPerPerson(),
    bucketSizes(),
    lastDispatchAt(),
  ]);
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  const people = staff.map((s) => {
    const row = byUser.get(s.userId);
    const cap = row ? {
      hoursPerWeek: Number(row.hoursPerWeek),
      workingDays: row.workingDays,
      preferredKinds: row.preferredKinds,
      active: row.active,
      updatedAt: row.updatedAt,
    } : null;
    const held = holdings.get(s.userId) ?? { new: 0, research: 0, other: 0, doneThisWeek: 0, oldestAssignedAt: null };
    return {
      id: s.userId,
      name: personName(s),
      email: s.email,
      role: s.role,
      capacity: cap,
      target: cap ? dailyTarget(cap.hoursPerWeek, cap.workingDays) : 0,
      held: { new: held.new, research: held.research, other: held.other },
      doneThisWeek: held.doneThisWeek,
      oldestAssignedAt: held.oldestAssignedAt,
    };
  }).sort((a, b) => Number(!!b.capacity) - Number(!!a.capacity) || a.name.localeCompare(b.name, "nl"));

  return c.json({
    people,
    buckets,
    lastRun,
    rules: { itemsPerHour: ITEMS_PER_HOUR, staleWorkingDays: STALE_WORKING_DAYS },
    kinds: [...KINDS].sort(),
  });
});

// PUT /api/management/capacity/:userId  { hoursPerWeek, workingDays, preferredKinds, active }
//   Creates or replaces the row. Only staff can take review-queue work.
capacity.put("/:userId", async (c) => {
  const admin = c.get("user");
  const userId = c.req.param("userId");
  if (!UUID.test(userId)) throw new ValidationError(["userId must be a user id"]);
  const body = await c.req.json().catch(() => null);
  const errors = validateCapacityBody(body, KINDS);
  if (errors.length) throw new ValidationError(errors);
  const v = normalizeCapacity(body as CapacityBody);

  const [member] = await db
    .select({ userId: organizationUser.userId })
    .from(organizationUser)
    .where(and(eq(organizationUser.userId, userId), eq(organizationUser.organizationId, env.PLATFORM_ORGANIZATION_ID)))
    .limit(1);
  if (!member) throw new ValidationError(["userId is not a staff member"]);

  const values = {
    hoursPerWeek: String(v.hoursPerWeek),
    workingDays: v.workingDays,
    preferredKinds: v.preferredKinds,
    active: v.active,
    updatedBy: admin.id,
    updatedAt: new Date(),
  };
  await db.insert(staffCapacity).values({ userId, ...values }).onConflictDoUpdate({ target: staffCapacity.userId, set: values });
  return c.json({ userId, ...v });
});

// DELETE /api/management/capacity/:userId
//   Takes the person out of the dispatcher. What they hold stays theirs.
capacity.delete("/:userId", async (c) => {
  const userId = c.req.param("userId");
  if (!UUID.test(userId)) throw new ValidationError(["userId must be a user id"]);
  const gone = await db.delete(staffCapacity).where(eq(staffCapacity.userId, userId)).returning({ userId: staffCapacity.userId });
  if (!gone.length) throw new NotFoundError("no capacity for this user");
  return c.json({ ok: true });
});

// POST /api/management/capacity/dispatch  { mode?, dryRun? }
//   The admin's preview (dryRun, the default) or run, with the per-person view.
capacity.post("/dispatch", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown; dryRun?: unknown };
  const mode = (body.mode ?? "all") as Mode;
  if (!MODES.has(mode)) throw new ValidationError(["mode must be new, drip or all"]);
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") throw new ValidationError(["dryRun must be true or false"]);
  return c.json(await runDispatch({ mode, dryRun: body.dryRun ?? true, actorId: c.get("user").id }));
});

export default capacity;
