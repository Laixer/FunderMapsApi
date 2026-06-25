import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { contractor } from "../../db/schema/application.ts";
import { NotFoundError, ConflictError } from "../../lib/errors.ts";
import type { AppEnv } from "../../types/context.ts";

const contractors = new Hono<AppEnv>();

// Contractor (uitvoerder) reference data. Read-only for the public
// /api/data/contractor endpoint; here admins can add and rename entries so the
// inquiry "Uitvoerder" dropdown can grow without a code change. Deletes are
// intentionally not exposed — contractors are referenced by attribution and
// recovery_sample rows (ON DELETE RESTRICT) and removing them would erase the
// history of who carried out the work.

contractors.get("/", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "100");
  const offset = parseInt(c.req.query("offset") ?? "0");

  const rows = await db
    .select()
    .from(contractor)
    .orderBy(contractor.name)
    .limit(limit)
    .offset(offset);

  return c.json(rows);
});

const createContractorSchema = z.object({ name: z.string().min(1) });

contractors.post("/", zValidator("json", createContractorSchema), async (c) => {
  const data = c.req.valid("json");

  const existing = await db
    .select()
    .from(contractor)
    .where(eq(contractor.name, data.name))
    .limit(1);
  if (existing.length > 0) throw new ConflictError("Contractor already exists");

  const [created] = await db
    .insert(contractor)
    .values({ name: data.name })
    .returning();

  return c.json(created, 201);
});

contractors.get("/:contractor_id", async (c) => {
  const contractorId = parseInt(c.req.param("contractor_id"));

  const rows = await db
    .select()
    .from(contractor)
    .where(eq(contractor.id, contractorId))
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("Contractor not found");
  return c.json(rows[0]);
});

const updateContractorSchema = z.object({ name: z.string().min(1).optional() });

contractors.put(
  "/:contractor_id",
  zValidator("json", updateContractorSchema),
  async (c) => {
    const contractorId = parseInt(c.req.param("contractor_id"));
    const data = c.req.valid("json");

    if (data.name) {
      const existing = await db
        .select()
        .from(contractor)
        .where(eq(contractor.name, data.name))
        .limit(1);
      if (existing.length > 0 && existing[0]!.id !== contractorId) {
        throw new ConflictError("Contractor name already in use");
      }
    }

    const [updated] = await db
      .update(contractor)
      .set({ ...(data.name && { name: data.name }) })
      .where(eq(contractor.id, contractorId))
      .returning();

    if (!updated) throw new NotFoundError("Contractor not found");
    return c.json(updated);
  },
);

export default contractors;
