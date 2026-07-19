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
