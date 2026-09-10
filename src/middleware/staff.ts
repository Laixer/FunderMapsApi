import { createMiddleware } from "hono/factory";
import { isPlatformMember } from "../lib/auth-helpers.ts";
import type { AppEnv } from "../types/context.ts";

// Staff-only surfaces: the review lane exposes documents from every
// organisation that has submitted one, and the verdicts recorded there
// become training data. "Staff" = member of the platform organisation
// (PLATFORM_ORGANIZATION_ID), the same notion the inquiry/recovery routes
// use for cross-org access — not the user.role administrator flag, which
// gates /api/management. Runs after authMiddleware.
export const staffMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  if (!isPlatformMember(c.get("user"))) {
    return c.json({ message: "Forbidden" }, 403);
  }
  return next();
});
