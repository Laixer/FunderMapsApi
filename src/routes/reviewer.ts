import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.ts";
import { organizationUser, user } from "../db/schema/application.ts";
import { ForbiddenError } from "../lib/errors.ts";
import { toLegacyUser } from "../lib/user-serializer.ts";
import type { AppEnv } from "../types/context.ts";

const reviewers = new Hono<AppEnv>();

reviewers.get("/", async (c) => {
  const u = c.get("user");
  const orgId = u.organizations[0]?.id;
  if (!orgId) {
    throw new ForbiddenError("User is not a member of any organization");
  }

  const rows = await db
    .select({ user, role: organizationUser.role })
    .from(user)
    .innerJoin(organizationUser, eq(user.id, organizationUser.userId))
    .where(
      and(
        eq(organizationUser.organizationId, orgId),
        inArray(organizationUser.role, ["verifier", "superuser"]),
      ),
    );

  return c.json(rows.map((r) => toLegacyUser(r.user)));
});

export default reviewers;
