import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  organization,
  organizationUser,
  user,
} from "../db/schema/application.ts";
import { NotFoundError, ForbiddenError } from "../lib/errors.ts";
import { toLegacyUser } from "../lib/user-serializer.ts";
import type { AppEnv } from "../types/context.ts";

const orgs = new Hono<AppEnv>();

function getActiveOrgId(c: Context<AppEnv>): string {
  const u = c.get("user");
  const id = u.organizations[0]?.id;
  if (!id) throw new ForbiddenError("User is not a member of any organization");
  return id;
}

orgs.get("/", async (c) => {
  const orgId = getActiveOrgId(c);
  const [row] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  if (!row) throw new NotFoundError("Organization not found");
  return c.json(row);
});

orgs.get("/all", async (c) => {
  if (c.get("user").role !== "administrator") {
    throw new ForbiddenError("Admin role required");
  }
  const rows = await db.select().from(organization).orderBy(organization.name);
  return c.json(rows);
});

orgs.get("/user", async (c) => {
  const orgId = getActiveOrgId(c);
  const rows = await db
    .select({ user, role: organizationUser.role })
    .from(user)
    .innerJoin(organizationUser, eq(user.id, organizationUser.userId))
    .where(eq(organizationUser.organizationId, orgId));

  return c.json(
    rows.map((r) => ({
      ...toLegacyUser(r.user),
      organization_role: r.role,
    })),
  );
});

orgs.get("/:org_id", async (c) => {
  const orgId = c.req.param("org_id");
  const u = c.get("user");
  const isMember = u.organizations.some((o) => o.id === orgId);
  if (!isMember && u.role !== "administrator") {
    throw new ForbiddenError("Not a member of this organization");
  }
  const [row] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  if (!row) throw new NotFoundError("Organization not found");
  return c.json(row);
});

export default orgs;
