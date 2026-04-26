import { db } from "../db/client.ts";
import { eq, and } from "drizzle-orm";
import { organizationUser } from "../db/schema/application.ts";
import { ForbiddenError } from "./errors.ts";

// Mirrors C# WriterAdministratorPolicy.
const WRITE_ROLES = new Set(["writer", "verifier", "superuser"]);

// Mirrors C# VerifierAdministratorPolicy — only verifiers and superusers
// (and the global "administrator" app role) can approve/reject reports.
const REVIEW_ROLES = new Set(["verifier", "superuser"]);

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

export async function assertCanWrite(
  userId: string,
  orgId: string | undefined,
): Promise<void> {
  if (!orgId) {
    throw new ForbiddenError("User is not a member of any organization");
  }
  const role = await getOrgRole(userId, orgId);
  if (!role || !WRITE_ROLES.has(role)) {
    throw new ForbiddenError("Write permission required");
  }
}

export async function assertCanReview(
  userId: string,
  orgId: string | undefined,
): Promise<void> {
  if (!orgId) {
    throw new ForbiddenError("User is not a member of any organization");
  }
  const role = await getOrgRole(userId, orgId);
  if (!role || !REVIEW_ROLES.has(role)) {
    throw new ForbiddenError("Verifier permission required");
  }
}
