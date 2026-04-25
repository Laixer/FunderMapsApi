import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { auth } from "../lib/auth.ts";
import { db } from "../db/client.ts";
import {
  user,
  authKey,
  organization,
  organizationUser,
} from "../db/schema/application.ts";
import { sha256Hex } from "../lib/api-key.ts";
import type { AppEnv, AuthUser } from "../types/context.ts";

async function loadUserWithOrgs(userId: string): Promise<AuthUser | null> {
  // Run user + orgs lookups in parallel — they're independent and this
  // halves the auth-middleware DB latency.
  const [rows, orgs] = await Promise.all([
    db.select().from(user).where(eq(user.id, userId)).limit(1),
    db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .innerJoin(
        organizationUser,
        eq(organization.id, organizationUser.organizationId),
      )
      .where(eq(organizationUser.userId, userId)),
  ]);

  if (rows.length === 0) return null;
  return { ...rows[0]!, organizations: orgs };
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  // API key auth — check X-API-Key header and Authorization: AuthKey header
  const apiKeyValue =
    c.req.header("X-API-Key") ??
    (c.req.header("Authorization")?.startsWith("AuthKey ")
      ? c.req.header("Authorization")!.slice(8)
      : undefined);

  if (apiKeyValue?.startsWith("fmsk.")) {
    // Hash-only lookup. Every existing key was backfilled in phase 1
    // and every new key is dual-written by the management route. The
    // plaintext column stays for the C# webservice on ws.fundermaps.com,
    // which authenticates via a separate read path.
    const incomingHash = await sha256Hex(apiKeyValue);
    const keyRow = await db
      .select()
      .from(authKey)
      .where(eq(authKey.keyHash, incomingHash))
      .limit(1);

    if (keyRow.length === 0) {
      return c.json({ message: "Unauthorized" }, 401);
    }

    const authUser = await loadUserWithOrgs(keyRow[0]!.userId);
    if (!authUser) {
      return c.json({ message: "Unauthorized" }, 401);
    }

    c.set("user", authUser);
    return next();
  }

  // Better Auth session (cookie or Bearer token via bearer plugin)
  const session = await auth.api
    .getSession({ headers: c.req.raw.headers })
    .catch(() => null);

  if (!session?.user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const authUser = await loadUserWithOrgs(session.user.id);
  if (!authUser) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  c.set("user", authUser);
  return next();
});
