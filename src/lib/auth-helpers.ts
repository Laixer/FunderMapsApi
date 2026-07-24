import { db } from "../db/client.ts";
import { eq, and } from "drizzle-orm";
import {
  organizationUser,
  organizationRole,
} from "../db/schema/application.ts";
import { ForbiddenError } from "./errors.ts";
import { env } from "../config.ts";
import { roles, type OrgAction, type OrgResource } from "./permissions.ts";

// FunderMaps' own staff belong to the platform organization and do invoer
// across customer organizations (#973 central-account workflow), so the
// per-org data scoping on inquiry/recovery routes does not apply to them.
export function isPlatformMember(user: {
  organizations: { id: string }[];
}): boolean {
  return user.organizations.some((o) => o.id === env.PLATFORM_ORGANIZATION_ID);
}

// The org product usage is attributed (billed) to: staff usage always lands
// on the platform org — never on a customer org they happen to be a member
// of. Everyone else is billed on their first org, which the auth middleware
// orders deterministically (platform first, then membership age).
export function billingOrgId(user: {
  organizations: { id: string }[];
}): string | undefined {
  return isPlatformMember(user)
    ? env.PLATFORM_ORGANIZATION_ID
    : user.organizations[0]?.id;
}

async function getOrgRole(
  userId: string,
  orgId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role: organizationUser.role })
    .from(organizationUser)
    .where(
      and(
        eq(organizationUser.userId, userId),
        eq(organizationUser.organizationId, orgId),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}

// Does `roleName` grant `action` on `resource` in this org? The four fixed
// roles resolve against the static permission map in permissions.ts; any
// other name is a dynamic role (#1006) defined by an org admin in
// application.organization_custom_role.
async function roleGrants(
  orgId: string,
  roleName: string,
  resource: OrgResource,
  action: OrgAction,
): Promise<boolean> {
  const staticRole = (
    roles as Record<
      string,
      { statements: Partial<Record<string, readonly string[]>> } | undefined
    >
  )[roleName];
  if (staticRole) {
    return staticRole.statements[resource]?.includes(action) ?? false;
  }

  const [row] = await db
    .select({ permission: organizationRole.permission })
    .from(organizationRole)
    .where(
      and(
        eq(organizationRole.organizationId, orgId),
        eq(organizationRole.role, roleName),
      ),
    )
    .limit(1);
  return row?.permission?.[resource]?.includes(action) ?? false;
}

export async function assertOrgPermission(
  userId: string,
  orgId: string | undefined,
  resource: OrgResource,
  action: OrgAction,
): Promise<void> {
  if (!orgId) {
    throw new ForbiddenError("User is not a member of any organization");
  }
  const role = await getOrgRole(userId, orgId);
  if (!role || !(await roleGrants(orgId, role, resource, action))) {
    throw new ForbiddenError(`'${action}' permission on ${resource} required`);
  }
}

// Pass when ANY of the user's orgs grants the permission — for actions not
// yet tied to a specific org (e.g. a document upload before the file is
// attached to an inquiry/recovery record).
export async function assertAnyOrgPermission(
  userId: string,
  orgIds: string[],
  resource: OrgResource,
  action: OrgAction,
): Promise<void> {
  for (const orgId of orgIds) {
    const role = await getOrgRole(userId, orgId);
    if (role && (await roleGrants(orgId, role, resource, action))) return;
  }
  throw new ForbiddenError(`'${action}' permission on ${resource} required`);
}
