import { Hono } from "hono";
import { customRoleStatement, roles } from "../../lib/permissions.ts";
import type { AppEnv } from "../../types/context.ts";

const permission = new Hono<AppEnv>();

// Static permission metadata for the portal roles UI (#1006): the
// resource→actions matrix a custom role may grant, plus what the four
// fixed roles resolve to (rendered read-only). Fixed-role statements can
// contain org-management resources beyond the matrix (superuser); the UI
// only renders the keys present in `resources`.
permission.get("/", (c) =>
  c.json({
    resources: customRoleStatement,
    fixed_roles: Object.fromEntries(
      Object.entries(roles).map(([name, role]) => [name, role.statements]),
    ),
  }),
);

export default permission;
