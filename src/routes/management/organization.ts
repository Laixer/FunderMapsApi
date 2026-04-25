import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.ts";
import {
  organization,
  organizationUser,
  user,
  mapsetCollection,
  organizationGeolockDistrict,
  organizationGeolockMunicipality,
  organizationGeolockNeighborhood,
} from "../../db/schema/application.ts";
import { organizationMapset } from "../../db/schema/application.ts";
import { district, municipality, neighborhood } from "../../db/schema/geocoder.ts";
import { NotFoundError, ConflictError } from "../../lib/errors.ts";
import type { AppEnv } from "../../types/context.ts";

const orgs = new Hono<AppEnv>();

// Organization CRUD
orgs.get("/", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "100");
  const offset = parseInt(c.req.query("offset") ?? "0");

  const rows = await db
    .select()
    .from(organization)
    .orderBy(organization.name)
    .limit(limit)
    .offset(offset);

  return c.json(rows);
});

const createOrgSchema = z.object({ name: z.string().min(1) });

orgs.post("/", zValidator("json", createOrgSchema), async (c) => {
  const data = c.req.valid("json");

  const existing = await db
    .select()
    .from(organization)
    .where(eq(organization.name, data.name))
    .limit(1);
  if (existing.length > 0) throw new ConflictError("Organization already exists");

  const [created] = await db
    .insert(organization)
    .values({ name: data.name })
    .returning();

  return c.json(created, 201);
});

orgs.get("/:org_id", async (c) => {
  const orgId = c.req.param("org_id");
  const rows = await db
    .select()
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("Organization not found");
  return c.json(rows[0]);
});

const updateOrgSchema = z.object({ name: z.string().min(1).optional() });

orgs.put("/:org_id", zValidator("json", updateOrgSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const data = c.req.valid("json");

  if (data.name) {
    const existing = await db
      .select()
      .from(organization)
      .where(eq(organization.name, data.name))
      .limit(1);
    if (existing.length > 0 && existing[0]!.id !== orgId) {
      throw new ConflictError("Organization name already in use");
    }
  }

  const [updated] = await db
    .update(organization)
    .set({ ...(data.name && { name: data.name }) })
    .where(eq(organization.id, orgId))
    .returning();

  if (!updated) throw new NotFoundError("Organization not found");
  return c.json(updated);
});

orgs.delete("/:org_id", async (c) => {
  const orgId = c.req.param("org_id");

  // Verify org exists
  const existing = await db
    .select()
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  if (existing.length === 0) throw new NotFoundError("Organization not found");

  // Cascade: remove all associations, then org
  await db
    .delete(organizationUser)
    .where(eq(organizationUser.organizationId, orgId));
  await db
    .delete(organizationMapset)
    .where(eq(organizationMapset.organizationId, orgId));
  await db
    .delete(organizationGeolockDistrict)
    .where(eq(organizationGeolockDistrict.organizationId, orgId));
  await db
    .delete(organizationGeolockMunicipality)
    .where(eq(organizationGeolockMunicipality.organizationId, orgId));
  await db
    .delete(organizationGeolockNeighborhood)
    .where(eq(organizationGeolockNeighborhood.organizationId, orgId));
  await db.delete(organization).where(eq(organization.id, orgId));

  return c.body(null, 204);
});

// Organization Users
orgs.get("/:org_id/user", async (c) => {
  const orgId = c.req.param("org_id");

  const rows = await db
    .select({ user })
    .from(user)
    .innerJoin(organizationUser, eq(user.id, organizationUser.userId))
    .where(eq(organizationUser.organizationId, orgId));

  return c.json(rows.map((r) => r.user));
});

const addUserSchema = z.object({
  user_id: z.string(),
  role: z.enum(["reader", "writer", "verifier", "superuser"]).default("reader"),
});

orgs.post("/:org_id/user", zValidator("json", addUserSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const data = c.req.valid("json");

  await db.insert(organizationUser).values({
    userId: data.user_id,
    organizationId: orgId,
    role: data.role,
  });

  return c.body(null, 201);
});

const removeUserSchema = z.object({ user_id: z.string() });

orgs.delete("/:org_id/user", zValidator("json", removeUserSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { user_id } = c.req.valid("json");

  await db
    .delete(organizationUser)
    .where(
      and(
        eq(organizationUser.userId, user_id),
        eq(organizationUser.organizationId, orgId),
      ),
    );

  return c.body(null, 204);
});

// Organization Mapsets
const mapsetSchema = z.object({ mapset_id: z.string() });

orgs.post("/:org_id/mapset", zValidator("json", mapsetSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { mapset_id } = c.req.valid("json");

  await db.insert(organizationMapset).values({
    organizationId: orgId,
    mapsetId: mapset_id,
  });

  return c.body(null, 201);
});

orgs.delete("/:org_id/mapset", zValidator("json", mapsetSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { mapset_id } = c.req.valid("json");

  await db
    .delete(organizationMapset)
    .where(
      and(
        eq(organizationMapset.organizationId, orgId),
        eq(organizationMapset.mapsetId, mapset_id),
      ),
    );

  return c.body(null, 204);
});

orgs.get("/:org_id/mapset", async (c) => {
  const orgId = c.req.param("org_id");

  const rows = await db
    .select({ mapset: mapsetCollection })
    .from(mapsetCollection)
    .innerJoin(
      organizationMapset,
      eq(organizationMapset.mapsetId, mapsetCollection.id),
    )
    .where(eq(organizationMapset.organizationId, orgId));

  return c.json(rows.map((r) => r.mapset));
});

// Geolock: Districts
const districtSchema = z.object({ district_id: z.string() });

orgs.get("/:org_id/district", async (c) => {
  const orgId = c.req.param("org_id");
  const rows = await db
    .select({ id: district.id, name: district.name })
    .from(organizationGeolockDistrict)
    .innerJoin(
      district,
      eq(district.id, organizationGeolockDistrict.districtId),
    )
    .where(eq(organizationGeolockDistrict.organizationId, orgId));
  return c.json(rows);
});

orgs.post("/:org_id/district", zValidator("json", districtSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { district_id } = c.req.valid("json");

  const [created] = await db
    .insert(organizationGeolockDistrict)
    .values({ organizationId: orgId, districtId: district_id })
    .onConflictDoNothing()
    .returning();

  return c.json(created, 201);
});

orgs.delete("/:org_id/district", zValidator("json", districtSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { district_id } = c.req.valid("json");

  await db
    .delete(organizationGeolockDistrict)
    .where(
      and(
        eq(organizationGeolockDistrict.organizationId, orgId),
        eq(organizationGeolockDistrict.districtId, district_id),
      ),
    );

  return c.body(null, 204);
});

// Geolock: Municipalities
const municipalitySchema = z.object({ municipality_id: z.string() });

orgs.get("/:org_id/municipality", async (c) => {
  const orgId = c.req.param("org_id");
  const rows = await db
    .select({ id: municipality.id, name: municipality.name })
    .from(organizationGeolockMunicipality)
    .innerJoin(
      municipality,
      eq(municipality.id, organizationGeolockMunicipality.municipalityId),
    )
    .where(eq(organizationGeolockMunicipality.organizationId, orgId));
  return c.json(rows);
});

orgs.post("/:org_id/municipality", zValidator("json", municipalitySchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { municipality_id } = c.req.valid("json");

  const [created] = await db
    .insert(organizationGeolockMunicipality)
    .values({ organizationId: orgId, municipalityId: municipality_id })
    .onConflictDoNothing()
    .returning();

  return c.json(created, 201);
});

orgs.delete("/:org_id/municipality", zValidator("json", municipalitySchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { municipality_id } = c.req.valid("json");

  await db
    .delete(organizationGeolockMunicipality)
    .where(
      and(
        eq(organizationGeolockMunicipality.organizationId, orgId),
        eq(organizationGeolockMunicipality.municipalityId, municipality_id),
      ),
    );

  return c.body(null, 204);
});

// Geolock: Neighborhoods
const neighborhoodSchema = z.object({ neighborhood_id: z.string() });

orgs.get("/:org_id/neighborhood", async (c) => {
  const orgId = c.req.param("org_id");
  const rows = await db
    .select({ id: neighborhood.id, name: neighborhood.name })
    .from(organizationGeolockNeighborhood)
    .innerJoin(
      neighborhood,
      eq(neighborhood.id, organizationGeolockNeighborhood.neighborhoodId),
    )
    .where(eq(organizationGeolockNeighborhood.organizationId, orgId));
  return c.json(rows);
});

orgs.post("/:org_id/neighborhood", zValidator("json", neighborhoodSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { neighborhood_id } = c.req.valid("json");

  const [created] = await db
    .insert(organizationGeolockNeighborhood)
    .values({ organizationId: orgId, neighborhoodId: neighborhood_id })
    .onConflictDoNothing()
    .returning();

  return c.json(created, 201);
});

orgs.delete("/:org_id/neighborhood", zValidator("json", neighborhoodSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { neighborhood_id } = c.req.valid("json");

  await db
    .delete(organizationGeolockNeighborhood)
    .where(
      and(
        eq(organizationGeolockNeighborhood.organizationId, orgId),
        eq(organizationGeolockNeighborhood.neighborhoodId, neighborhood_id),
      ),
    );

  return c.body(null, 204);
});

export default orgs;
