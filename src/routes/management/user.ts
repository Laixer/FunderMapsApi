import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { user, authKey } from "../../db/schema/application.ts";
import { paginationSchema } from "../../lib/pagination.ts";
import { NotFoundError, ConflictError } from "../../lib/errors.ts";
import type { AppEnv } from "../../types/context.ts";

const users = new Hono<AppEnv>();

users.get("/", async (c) => {
  const { limit, offset } = paginationSchema.parse(c.req.query());
  const rows = await db.select().from(user).limit(limit).offset(offset);
  return c.json(rows);
});

const createUserSchema = z.object({
  email: z.email(),
});

users.post("/", zValidator("json", createUserSchema), async (c) => {
  const data = c.req.valid("json");
  const email = data.email.toLowerCase().trim();

  // Check for duplicate
  const existing = await db
    .select()
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (existing.length > 0) throw new ConflictError("User already exists");

  // With ZITADEL, we don't manage passwords — just create the local user record
  const [created] = await db
    .insert(user)
    .values({
      email,
      passwordHash: "", // Not used with ZITADEL
      role: "user",
    })
    .returning();

  return c.json(created, 201);
});

users.get("/:user_id", async (c) => {
  const userId = c.req.param("user_id");
  const rows = await db
    .select()
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("User not found");
  return c.json(rows[0]);
});

const updateUserSchema = z.object({
  email: z.email().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  picture: z.string().optional(),
  job_title: z.string().optional(),
  phone_number: z.string().optional(),
});

users.put("/:user_id", zValidator("json", updateUserSchema), async (c) => {
  const userId = c.req.param("user_id");
  const input = c.req.valid("json");

  // Check email uniqueness if changing
  if (input.email) {
    const existing = await db
      .select()
      .from(user)
      .where(eq(user.email, input.email.toLowerCase()))
      .limit(1);
    if (existing.length > 0 && existing[0]!.id !== userId) {
      throw new ConflictError("Email already in use");
    }
  }

  const toNullable = (v: string | undefined) =>
    v === undefined ? undefined : v === "" ? null : v;

  const [updated] = await db
    .update(user)
    .set({
      ...(input.email && { email: input.email.toLowerCase().trim() }),
      givenName: toNullable(input.given_name),
      lastName: toNullable(input.family_name),
      avatar: toNullable(input.picture),
      jobTitle: toNullable(input.job_title),
      phoneNumber: toNullable(input.phone_number),
    })
    .where(eq(user.id, userId))
    .returning();

  if (!updated) throw new NotFoundError("User not found");
  return c.json(updated);
});

users.get("/:user_id/api-key", async (c) => {
  const userId = c.req.param("user_id");

  // Verify user exists
  const existing = await db
    .select()
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (existing.length === 0) throw new NotFoundError("User not found");

  const [key] = await db
    .insert(authKey)
    .values({ key: `fmsk.${crypto.randomUUID().replaceAll("-", "")}`, userId })
    .returning();

  return c.json(key, 201);
});

export default users;
