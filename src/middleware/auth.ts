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
      .select({
        id: organization.id,
        name: organization.name,
        role: organizationUser.role,
      })
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
  // API key auth — check three header shapes:
  //   X-API-Key: fmsk.xxx
  //   Authorization: AuthKey fmsk.xxx
  //   Authorization: Bearer fmsk.xxx       (matches FunderMapsWebservice)
  // The Bearer match is conditioned on the `fmsk.` prefix so session
  // tokens (also Bearer-shaped) still fall through to the BA path below.
  const authHeader = c.req.header("Authorization");
  const apiKeyValue =
    c.req.header("X-API-Key") ??
    authHeader?.match(/^AuthKey\s+(.+)$/i)?.[1] ??
    authHeader?.match(/^Bearer\s+(fmsk\..+)$/i)?.[1];

  if (apiKeyValue?.startsWith("fmsk.")) {
    // Dual-read: try Better Auth's api-key plugin first (new keys live
    // in application.apikey), fall back to the legacy SHA-256 lookup
    // against application.auth_key for keys created before the plugin
    // landed. Phase B.1 of the apiKey migration; see
    // project_better_auth_migration.md Step 5.
    //
    // BA-first ordering is deliberate: as customers rotate to plugin-
    // issued keys, the hot path moves naturally to BA without any code
    // change. The legacy fallback shrinks over time and gets removed
    // once application.auth_key is empty (Phase D, post-Dec-2026 when
    // the C# Webservice retires).
    const baResult = await auth.api
      .verifyApiKey({ body: { key: apiKeyValue } })
      .catch(() => null);

    let userId: string | null = null;
    if (baResult?.valid && baResult.key) {
      userId = baResult.key.referenceId;
    } else if (
      baResult &&
      !baResult.valid &&
      baResult.error?.code &&
      baResult.error.code !== "INVALID_API_KEY"
    ) {
      // BA found the key and explicitly rejected it (KEY_DISABLED,
      // KEY_EXPIRED, RATE_LIMIT_EXCEEDED, etc). Do not silently bypass
      // that decision by checking the legacy table — BA-issued keys
      // never exist there anyway. INVALID_API_KEY is the "didn't match
      // any row" case and the only one that warrants falling through.
      return c.json({ message: "Unauthorized" }, 401);
    } else {
      // BA miss (INVALID_API_KEY or call failed). Fall through to the
      // legacy application.auth_key table for keys created before the
      // plugin landed.
      const incomingHash = await sha256Hex(apiKeyValue);
      const keyRow = await db
        .select()
        .from(authKey)
        .where(eq(authKey.keyHash, incomingHash))
        .limit(1);
      if (keyRow.length > 0) userId = keyRow[0]!.userId;
    }

    if (!userId) {
      return c.json({ message: "Unauthorized" }, 401);
    }

    const authUser = await loadUserWithOrgs(userId);
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
