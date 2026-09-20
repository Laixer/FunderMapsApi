import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

// Access-control statements for the FunderMaps domain (#1006), layered on
// top of Better Auth's org-management defaults (organization / member /
// invitation / team / ac) so org superusers can also manage membership and
// dynamic roles through the BA endpoints.
//
// `assign-owner` is the #973 central-account action: setting or moving a
// record's data-owner organization. `app: ["access"]` is the per-org
// app.fundermaps.com on/off switch #1006 asks for.
// `contractor: ["create"]` is #194: the review lane reads the uitvoerder off
// a report cover and 465 of 489 spellings match nothing in
// application.contractor, so a reviewer needs to add one without waiting for
// an administrator. The list is global reference data shared by every
// organisation, not org-scoped records, so the route that uses this also
// sits behind staffMiddleware -- the role decides the *level*, platform
// membership decides *who*. Deliberately absent from customRoleStatement
// below: an org admin must not be able to mint the right to grow a table
// every other organisation reads.
export const statement = {
  ...defaultStatements,
  inquiry: ["read", "write", "review", "delete", "assign-owner"],
  recovery: ["read", "write", "review", "delete", "assign-owner"],
  incident: ["read", "write"],
  contractor: ["create"],
  app: ["access"],
} as const;

export const ac = createAccessControl(statement);

// The four fixed roles keep the exact names stored in
// application.organization_user.role, so no data migration is needed and
// the legacy C# role semantics carry over 1:1:
//   reader   → view only            (C# ReaderPolicy)
//   writer   → create/edit          (C# WriterAdministratorPolicy)
//   verifier → writer + approve     (C# VerifierAdministratorPolicy)
//              + add a contractor (#194)
//   superuser→ org admin: everything, incl. destructive + member management
export const reader = ac.newRole({
  app: ["access"],
  inquiry: ["read"],
  recovery: ["read"],
  incident: ["read"],
});

export const writer = ac.newRole({
  app: ["access"],
  inquiry: ["read", "write"],
  recovery: ["read", "write"],
  incident: ["read", "write"],
});

export const verifier = ac.newRole({
  app: ["access"],
  inquiry: ["read", "write", "review"],
  recovery: ["read", "write", "review"],
  incident: ["read", "write"],
  contractor: ["create"],
});

export const superuser = ac.newRole({
  app: ["access"],
  inquiry: ["read", "write", "review", "delete", "assign-owner"],
  recovery: ["read", "write", "review", "delete", "assign-owner"],
  incident: ["read", "write"],
  contractor: ["create"],
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
});

export const roles = { reader, writer, verifier, superuser };

export const FIXED_ROLE_NAMES = [
  "reader",
  "writer",
  "verifier",
  "superuser",
] as const;

export function isFixedRole(name: string): boolean {
  return (FIXED_ROLE_NAMES as readonly string[]).includes(name);
}

// The subset of the statement a dynamic custom role (#1006) may grant.
// Org-management statements (organization/member/invitation/team/ac) stay
// exclusive to the fixed superuser role — custom roles configure domain
// access only. Also the contract for the portal's permission matrix.
export const customRoleStatement = {
  inquiry: statement.inquiry,
  recovery: statement.recovery,
  incident: statement.incident,
  app: statement.app,
} as const;

export type OrgResource =
  | "inquiry"
  | "recovery"
  | "incident"
  | "contractor"
  | "app";
export type OrgAction =
  | "read"
  | "write"
  | "review"
  | "delete"
  | "assign-owner"
  | "create"
  | "access";
