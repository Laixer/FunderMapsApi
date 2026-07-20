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
export const statement = {
  ...defaultStatements,
  inquiry: ["read", "write", "review", "delete", "assign-owner"],
  recovery: ["read", "write", "review", "delete", "assign-owner"],
  incident: ["read", "write"],
  app: ["access"],
} as const;

export const ac = createAccessControl(statement);

// The four fixed roles keep the exact names stored in
// application.organization_user.role, so no data migration is needed and
// the legacy C# role semantics carry over 1:1:
//   reader   → view only            (C# ReaderPolicy)
//   writer   → create/edit          (C# WriterAdministratorPolicy)
//   verifier → writer + approve     (C# VerifierAdministratorPolicy)
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
});

export const superuser = ac.newRole({
  app: ["access"],
  inquiry: ["read", "write", "review", "delete", "assign-owner"],
  recovery: ["read", "write", "review", "delete", "assign-owner"],
  incident: ["read", "write"],
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
});

export const roles = { reader, writer, verifier, superuser };

export type OrgResource = "inquiry" | "recovery" | "incident" | "app";
export type OrgAction =
  | "read"
  | "write"
  | "review"
  | "delete"
  | "assign-owner"
  | "access";
