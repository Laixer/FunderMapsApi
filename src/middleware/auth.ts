import { createMiddleware } from "hono/factory";
import * as jose from "jose";
import { eq } from "drizzle-orm";
import { env } from "../config.ts";
import { db } from "../db/client.ts";
import { authKey, user, organization, organizationUser } from "../db/schema/application.ts";
import type { AppEnv, AuthUser } from "../types/context.ts";

let jwks: jose.JWTVerifyGetKey;

function getJWKS(): jose.JWTVerifyGetKey {
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(
      new URL(`${env.ZITADEL_ISSUER}/oauth/v2/keys`),
    );
  }
  return jwks;
}

async function loadUserWithOrgs(userId: string): Promise<AuthUser | null> {
  const rows = await db
    .select()
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (rows.length === 0) return null;

  const orgs = await db
    .select({ id: organization.id, name: organization.name, email: organization.email })
    .from(organization)
    .innerJoin(organizationUser, eq(organization.id, organizationUser.organizationId))
    .where(eq(organizationUser.userId, userId));

  return { ...rows[0]!, organizations: orgs };
}

async function resolveUserByEmail(email: string): Promise<AuthUser | null> {
  const rows = await db
    .select()
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (rows.length === 0) return null;

  const orgs = await db
    .select({ id: organization.id, name: organization.name, email: organization.email })
    .from(organization)
    .innerJoin(organizationUser, eq(organization.id, organizationUser.organizationId))
    .where(eq(organizationUser.userId, rows[0]!.id));

  return { ...rows[0]!, organizations: orgs };
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  // API key auth (fmsk. prefix)
  const apiKeyHeader = c.req.header("X-API-Key");
  if (apiKeyHeader?.startsWith("fmsk.")) {
    const keyRow = await db
      .select()
      .from(authKey)
      .where(eq(authKey.key, apiKeyHeader))
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

  // JWT auth via ZITADEL
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const keySet = getJWKS();
    const { payload } = await jose.jwtVerify(token, keySet, {
      issuer: env.ZITADEL_ISSUER,
      ...(env.ZITADEL_CLIENT_ID && { audience: env.ZITADEL_CLIENT_ID }),
    });

    const email = payload.email as string | undefined;
    if (!email) {
      return c.json({ message: "Unauthorized" }, 401);
    }

    const authUser = await resolveUserByEmail(email);
    if (!authUser) {
      return c.json({ message: "Unauthorized" }, 401);
    }

    c.set("user", authUser);
  } catch {
    return c.json({ message: "Unauthorized" }, 401);
  }

  return next();
});
