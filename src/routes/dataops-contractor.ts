import { Hono } from "hono";
import { asc } from "drizzle-orm";
import { db } from "../db/client.ts";
import { contractor } from "../db/schema/application.ts";
import { findDuplicateContractor } from "../lib/contractor-match.ts";
import { assertOrgPermission } from "../lib/auth-helpers.ts";
import { ValidationError } from "../lib/errors.ts";
import { env } from "../config.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * Adding the uitvoerder the pipeline read but the list does not have (#194).
 *
 * The reader lifts the bureau's name off the report cover on nearly every
 * document; `application.contractor` holds 103 rows and 465 of the 489
 * distinct spellings match none of them. What happens today is that
 * `dataops-commit.ts` writes "Uitvoerder volgens nalezing (niet in de lijst):
 * <naam>" into the inquiry note and leaves the contractor empty -- the name
 * is read and then buried in free text nobody can filter on.
 *
 * Until now the only way to add one was `POST /api/management/contractor`,
 * behind `adminMiddleware` -- the *global* `administrator` role, which two of
 * 174 users hold. Of the four people who recorded a verdict in the last 30
 * days, three hold it not at all; they carry 988 of the 1,951 verdicts and
 * would have got a 403. So the endpoint existed and the people doing the work
 * could not reach it.
 *
 * It lives here rather than beside the public `GET /api/data/contractor`
 * because the caller is the review lane and this whole prefix is already
 * `authMiddleware, staffMiddleware`. That split is the authorisation model:
 * **platform membership decides who, the org role decides the level.**
 * `contractor: ["create"]` (permissions.ts) is granted to verifier and
 * superuser, so a `reader` in the platform org -- we have those -- still
 * cannot grow a table every organisation reads.
 */
const routes = new Hono<AppEnv>();

/** Longer than any name in the table today (the longest is 62 characters). */
const MAX_NAME = 128;

routes.post("/contractor", async (c) => {
  const u = c.get("user");
  // The level is read from the role in the *platform* org, not from whichever
  // org happens to grant it. `assertAnyOrgPermission` would pass a staff
  // member who is a reader here and a superuser at a customer -- nobody is
  // that today, but the resource is platform reference data, so the org that
  // owns it is the one that should decide. staffMiddleware has already
  // established that this user is a member of it.
  await assertOrgPermission(
    u.id,
    env.PLATFORM_ORGANIZATION_ID,
    "contractor",
    "create",
  );

  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim().replace(/\s+/g, " ") ?? "";
  if (!name) throw new ValidationError(["name is required"]);
  if (name.length > MAX_NAME) {
    throw new ValidationError([`name must be at most ${MAX_NAME} characters`]);
  }

  const rows = await db
    .select({ id: contractor.id, name: contractor.name })
    .from(contractor)
    .orderBy(asc(contractor.id));

  // Never create a row the matcher would already have resolved: the name only
  // reaches this endpoint because matchContractor() returned null for it, so
  // a hit here means the caller is working from a stale list. Hand back the
  // existing row instead of a 409 -- the reviewer wants a contractor id to
  // commit with, and which of the two it is does not change their next click.
  const duplicate = findDuplicateContractor(
    name,
    rows.filter((r): r is { id: number; name: string } => r.name !== null),
  );
  if (duplicate) return c.json({ ...duplicate, created: false });

  const [created] = await db
    .insert(contractor)
    .values({ name })
    .returning({ id: contractor.id, name: contractor.name });

  return c.json({ ...created, created: true }, 201);
});

export default routes;
