import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import {
  organization,
  organizationUser,
  organizationRole,
  user,
  mapsetCollection,
  organizationGeolockDistrict,
  organizationGeolockMunicipality,
  organizationGeolockNeighborhood,
} from "../../db/schema/application.ts";
import { organizationMapset } from "../../db/schema/application.ts";
import { district, municipality, neighborhood } from "../../db/schema/geocoder.ts";
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from "../../lib/errors.ts";
import { isFixedRole, customRoleStatement } from "../../lib/permissions.ts";
import { toLegacyUser } from "../../lib/user-serializer.ts";
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

// Same slug rule as the Better Auth org-schema migration: lowercase,
// non-alnum runs collapse to '-', trimmed.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

orgs.post("/", zValidator("json", createOrgSchema), async (c) => {
  const data = c.req.valid("json");

  const existing = await db
    .select()
    .from(organization)
    .where(eq(organization.name, data.name))
    .limit(1);
  if (existing.length > 0) throw new ConflictError("Organization already exists");

  const slug = slugify(data.name);
  const slugTaken = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);

  const [created] = await db
    .insert(organization)
    .values({
      name: data.name,
      // Names are unique (checked above) but distinct names can slugify to
      // the same value; disambiguate like the migration backfill did.
      slug: slugTaken.length > 0
        ? `${slug}-${crypto.randomUUID().split("-")[0]}`
        : slug,
    })
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
    .select({ user, role: organizationUser.role })
    .from(user)
    .innerJoin(organizationUser, eq(user.id, organizationUser.userId))
    .where(eq(organizationUser.organizationId, orgId));

  return c.json(
    rows.map((r) => ({
      ...toLegacyUser(r.user),
      organization_role: r.role,
    })),
  );
});

// A member's role is either one of the four fixed roles or a custom role
// defined for this organization (#1006).
async function assertAssignableRole(orgId: string, role: string): Promise<void> {
  if (isFixedRole(role)) return;
  const rows = await db
    .select({ id: organizationRole.id })
    .from(organizationRole)
    .where(
      and(
        eq(organizationRole.organizationId, orgId),
        eq(organizationRole.role, role),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new ValidationError([
      `Unknown role '${role}' for this organization`,
    ]);
  }
}

const addUserSchema = z.object({
  user_id: z.string(),
  role: z.string().min(1).default("reader"),
});

orgs.post("/:org_id/user", zValidator("json", addUserSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const data = c.req.valid("json");

  await assertAssignableRole(orgId, data.role);

  await db.insert(organizationUser).values({
    userId: data.user_id,
    organizationId: orgId,
    role: data.role,
  });

  return c.body(null, 201);
});

const updateMemberSchema = z.object({
  user_id: z.string(),
  role: z.string().min(1),
});

orgs.put("/:org_id/user", zValidator("json", updateMemberSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { user_id, role } = c.req.valid("json");

  await assertAssignableRole(orgId, role);

  const [updated] = await db
    .update(organizationUser)
    .set({ role })
    .where(
      and(
        eq(organizationUser.userId, user_id),
        eq(organizationUser.organizationId, orgId),
      ),
    )
    .returning();

  if (!updated) {
    throw new NotFoundError("User is not a member of this organization");
  }
  return c.json({
    user_id: updated.userId,
    organization_id: updated.organizationId,
    role: updated.role,
  });
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

// Dynamic custom roles (#1006): admin-defined per-organization roles with a
// JSON permission map, stored in application.organization_custom_role. Only
// domain statements (customRoleStatement) can be granted — org management
// stays exclusive to the fixed superuser role.
const rolePermissionSchema = z.strictObject(
  Object.fromEntries(
    Object.entries(customRoleStatement).map(([resource, actions]) => [
      resource,
      z.array(z.enum(actions as unknown as [string, ...string[]])).optional(),
    ]),
  ),
);

// Drop unchecked resources (undefined / empty action lists) so the stored
// jsonb only holds actual grants.
function compactPermission(
  permission: Record<string, string[] | undefined>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(permission).filter(
      (entry): entry is [string, string[]] =>
        entry[1] !== undefined && entry[1].length > 0,
    ),
  );
}

const roleNameSchema = z.string().trim().min(1).max(64);

orgs.get("/:org_id/role", async (c) => {
  const orgId = c.req.param("org_id");
  const rows = await db
    .select()
    .from(organizationRole)
    .where(eq(organizationRole.organizationId, orgId))
    .orderBy(organizationRole.role);
  return c.json(rows);
});

const createRoleSchema = z.object({
  name: roleNameSchema,
  permission: rolePermissionSchema,
});

orgs.post("/:org_id/role", zValidator("json", createRoleSchema), async (c) => {
  const orgId = c.req.param("org_id");
  const { name, permission } = c.req.valid("json");

  if (isFixedRole(name)) {
    throw new ConflictError(`'${name}' is a fixed role name`);
  }
  const existing = await db
    .select({ id: organizationRole.id })
    .from(organizationRole)
    .where(
      and(
        eq(organizationRole.organizationId, orgId),
        eq(organizationRole.role, name),
      ),
    )
    .limit(1);
  if (existing.length > 0) throw new ConflictError("Role already exists");

  const [created] = await db
    .insert(organizationRole)
    .values({
      organizationId: orgId,
      role: name,
      permission: compactPermission(permission),
    })
    .returning();

  return c.json(created, 201);
});

const updateRoleSchema = z.object({
  name: roleNameSchema.optional(),
  permission: rolePermissionSchema.optional(),
});

orgs.put(
  "/:org_id/role/:role_id",
  zValidator("json", updateRoleSchema),
  async (c) => {
    const orgId = c.req.param("org_id");
    const roleId = c.req.param("role_id");
    const input = c.req.valid("json");

    const [current] = await db
      .select()
      .from(organizationRole)
      .where(
        and(
          eq(organizationRole.id, roleId),
          eq(organizationRole.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!current) throw new NotFoundError("Role not found");

    const rename = input.name !== undefined && input.name !== current.role;
    if (rename) {
      if (isFixedRole(input.name!)) {
        throw new ConflictError(`'${input.name}' is a fixed role name`);
      }
      const clash = await db
        .select({ id: organizationRole.id })
        .from(organizationRole)
        .where(
          and(
            eq(organizationRole.organizationId, orgId),
            eq(organizationRole.role, input.name!),
          ),
        )
        .limit(1);
      if (clash.length > 0) throw new ConflictError("Role already exists");
    }

    // A rename must carry the members holding the old name along —
    // organization_user.role references the role by name, not id.
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(organizationRole)
        .set({
          ...(input.name !== undefined && { role: input.name }),
          ...(input.permission !== undefined && {
            permission: compactPermission(input.permission),
          }),
          updatedAt: new Date(),
        })
        .where(eq(organizationRole.id, roleId))
        .returning();
      if (rename) {
        await tx
          .update(organizationUser)
          .set({ role: input.name! })
          .where(
            and(
              eq(organizationUser.organizationId, orgId),
              eq(organizationUser.role, current.role),
            ),
          );
      }
      return row;
    });

    return c.json(updated);
  },
);

orgs.delete("/:org_id/role/:role_id", async (c) => {
  const orgId = c.req.param("org_id");
  const roleId = c.req.param("role_id");

  const [current] = await db
    .select()
    .from(organizationRole)
    .where(
      and(
        eq(organizationRole.id, roleId),
        eq(organizationRole.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!current) throw new NotFoundError("Role not found");

  const members = await db
    .select({ userId: organizationUser.userId })
    .from(organizationUser)
    .where(
      and(
        eq(organizationUser.organizationId, orgId),
        eq(organizationUser.role, current.role),
      ),
    )
    .limit(1);
  if (members.length > 0) {
    throw new ConflictError(
      "Role is assigned to organization members and cannot be deleted",
    );
  }

  await db.delete(organizationRole).where(eq(organizationRole.id, roleId));
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
    .select({ id: district.externalId, name: district.name })
    .from(organizationGeolockDistrict)
    .innerJoin(
      district,
      eq(district.externalId, organizationGeolockDistrict.districtId),
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
    .select({ id: municipality.externalId, name: municipality.name })
    .from(organizationGeolockMunicipality)
    .innerJoin(
      municipality,
      eq(municipality.externalId, organizationGeolockMunicipality.municipalityId),
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
    .select({ id: neighborhood.externalId, name: neighborhood.name })
    .from(organizationGeolockNeighborhood)
    .innerJoin(
      neighborhood,
      eq(neighborhood.externalId, organizationGeolockNeighborhood.neighborhoodId),
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

// Billable product usage for one organization, read straight off
// application.product_tracker. That table is a TimescaleDB hypertable and
// already carries a (organization_id, product, identifier, create_date)
// index, so this stays an index scan rather than a 26M-row seq scan.
//
// Deliberately narrow: Grafana (analytics.fundermaps.com) owns trends, time
// series and alerting. This endpoint answers the one question you have while
// already looking at an organization — "what is this customer consuming right
// now" — next to their rate limits.
//
// Both windows are counted in a single pass. The WHERE floor uses least() of
// the two because neither window always contains the other: month-to-date is
// shorter than 30 days for most of a month, but longer on the 31st.
orgs.get("/:org_id/usage", async (c) => {
  const orgId = c.req.param("org_id");

  const rows = await db.execute(sql`
    SELECT
      product,
      count(*) FILTER (WHERE create_date >= date_trunc('month', now())) AS month_to_date,
      count(*) FILTER (WHERE create_date >= now() - interval '30 days') AS last_30_days
    FROM application.product_tracker
    WHERE organization_id = ${orgId}
      AND create_date >= least(date_trunc('month', now()), now() - interval '30 days')
    GROUP BY product
    ORDER BY 3 DESC, 1 ASC
  `);

  // count() arrives as a bigint, which postgres.js hands back as a string.
  const products = [...rows].map((r) => ({
    product: String(r.product),
    month_to_date: Number(r.month_to_date),
    last_30_days: Number(r.last_30_days),
  }));

  return c.json({
    products,
    total: {
      month_to_date: products.reduce((sum, p) => sum + p.month_to_date, 0),
      last_30_days: products.reduce((sum, p) => sum + p.last_30_days, 0),
    },
  });
});

export default orgs;
