import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import {
  apiKeyRateLimit,
  apikey,
  authKey,
  organization,
  organizationUser,
} from "../../db/schema/application.ts";
import { NotFoundError } from "../../lib/errors.ts";
import type { AppEnv } from "../../types/context.ts";

// Admin CRUD for application.api_key_rate_limit — the per-(API key, product)
// billing-event limits enforced by the TS FunderMapsWebservice (issue #8).
// The Webservice reads this table by (api_key_id, source, product); only this
// surface writes it. Config is keyed per key, but overage is *counted* per
// tenant (org) on product_tracker — so a limit on a key effectively caps the
// whole org's billable events for that product. See FunderMapsWebservice#16.
//
// Request/response use snake_case to match the rest of /api/management/* (the
// legacy C# WebApi shape the frontend already speaks).

const rate = new Hono<AppEnv>();

// Products and periods must match the values the Webservice enforces against
// (src/rate-limit.ts + the rateLimit(<product>) wrappers in routes/product.ts).
// A config row for any other product would simply never be consulted.
const PRODUCTS = ["analysis3", "risk3", "light3", "statistics3"] as const;
const PERIODS = ["day", "month"] as const;
const SOURCES = ["ba", "legacy"] as const;

type RateLimitRow = typeof apiKeyRateLimit.$inferSelect;
function toResponse(r: RateLimitRow) {
  return {
    api_key_id: r.apiKeyId,
    source: r.source,
    product: r.product,
    period: r.period,
    limit_count: r.limitCount,
    created_at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    updated_at: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  };
}

// List every configured limit. The frontend joins these against
// /rate-limit/keys (by source + api_key_id) to show key/org labels.
rate.get("/", async (c) => {
  const rows = await db
    .select()
    .from(apiKeyRateLimit)
    .orderBy(
      asc(apiKeyRateLimit.source),
      asc(apiKeyRateLimit.apiKeyId),
      asc(apiKeyRateLimit.product),
    );
  return c.json(rows.map(toResponse));
});

// Selectable API keys for the limit picker, from both key tables. Each row
// carries its `source` so the upsert below can round-trip it. A key whose
// owner sits in multiple orgs appears once per org (matches how the
// Webservice resolves tenant context via organization_user).
rate.get("/keys", async (c) => {
  const baKeys = await db
    .select({
      apiKeyId: apikey.id,
      name: apikey.name,
      enabled: apikey.enabled,
      expiresAt: apikey.expiresAt,
      organizationId: organizationUser.organizationId,
      organizationName: organization.name,
    })
    .from(apikey)
    .leftJoin(organizationUser, eq(organizationUser.userId, apikey.referenceId))
    .leftJoin(organization, eq(organization.id, organizationUser.organizationId))
    .orderBy(asc(organization.name), asc(apikey.name));

  const legacyKeys = await db
    .select({
      apiKeyId: authKey.id,
      name: authKey.name,
      expiresAt: authKey.expiresAt,
      organizationId: organizationUser.organizationId,
      organizationName: organization.name,
    })
    .from(authKey)
    .leftJoin(organizationUser, eq(organizationUser.userId, authKey.userId))
    .leftJoin(organization, eq(organization.id, organizationUser.organizationId))
    .orderBy(asc(organization.name), asc(authKey.name));

  const shape = (k: {
    apiKeyId: string;
    name: string | null;
    expiresAt: Date | null;
    organizationId: string | null;
    organizationName: string | null;
  }, source: "ba" | "legacy", enabled: boolean) => ({
    api_key_id: k.apiKeyId,
    source,
    name: k.name,
    enabled,
    expires_at: k.expiresAt ? new Date(k.expiresAt).toISOString() : null,
    organization_id: k.organizationId,
    organization_name: k.organizationName,
  });

  return c.json([
    ...baKeys.map((k) => shape(k, "ba", k.enabled ?? true)),
    // auth_key has no `enabled` column; treat every legacy key as enabled.
    ...legacyKeys.map((k) => shape(k, "legacy", true)),
  ]);
});

const upsertSchema = z.object({
  api_key_id: z.string().min(1),
  source: z.enum(SOURCES),
  product: z.enum(PRODUCTS),
  period: z.enum(PERIODS),
  limit_count: z.number().int().min(0),
});

// Create or replace the limit for a (key, source, product). Idempotent.
// api_key_id has no FK (it spans two tables), so we don't validate key
// existence here — the picker only offers real keys.
rate.put("/", zValidator("json", upsertSchema), async (c) => {
  const body = c.req.valid("json");

  const [row] = await db
    .insert(apiKeyRateLimit)
    .values({
      apiKeyId: body.api_key_id,
      source: body.source,
      product: body.product,
      period: body.period,
      limitCount: body.limit_count,
    })
    .onConflictDoUpdate({
      target: [
        apiKeyRateLimit.apiKeyId,
        apiKeyRateLimit.source,
        apiKeyRateLimit.product,
      ],
      set: { period: body.period, limitCount: body.limit_count, updatedAt: new Date() },
    })
    .returning();

  return c.json(toResponse(row!));
});

rate.delete("/:source/:api_key_id/:product", async (c) => {
  const source = c.req.param("source");
  const apiKeyId = c.req.param("api_key_id");
  const product = c.req.param("product");

  const where = and(
    eq(apiKeyRateLimit.source, source),
    eq(apiKeyRateLimit.apiKeyId, apiKeyId),
    eq(apiKeyRateLimit.product, product),
  );

  const deleted = await db
    .delete(apiKeyRateLimit)
    .where(where)
    .returning({ apiKeyId: apiKeyRateLimit.apiKeyId });

  if (deleted.length === 0) throw new NotFoundError("Rate limit not found");
  return c.body(null, 204);
});

export default rate;
