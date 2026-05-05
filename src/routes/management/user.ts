import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.ts";
import {
  user,
  authKey,
  account,
  session,
  organizationUser,
  attribution,
} from "../../db/schema/application.ts";
import { or } from "drizzle-orm";
import { auth } from "../../lib/auth.ts";
import { hashPassword } from "better-auth/crypto";
import { paginationSchema } from "../../lib/pagination.ts";
import { NotFoundError, ConflictError } from "../../lib/errors.ts";
import {
  toLegacyUser,
  toLegacyAuthKey,
  toLegacyAuthKeyCreated,
} from "../../lib/user-serializer.ts";
import { generateApiKey, sha256Hex } from "../../lib/api-key.ts";
import type { AppEnv } from "../../types/context.ts";

const users = new Hono<AppEnv>();

users.get("/", async (c) => {
  const { limit, offset } = paginationSchema.parse(c.req.query());
  const rows = await db.select().from(user).limit(limit).offset(offset);
  return c.json(rows.map((u) => toLegacyUser(u)));
});

const createUserSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  name: z.string().optional(),
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

  // Create user via Better Auth (handles password hashing + account creation)
  const result = await auth.api.signUpEmail({
    body: {
      email,
      password: data.password,
      name: data.name ?? email,
    },
  });

  return c.json(result.user, 201);
});

users.get("/:user_id", async (c) => {
  const userId = c.req.param("user_id");
  const rows = await db
    .select()
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("User not found");
  return c.json(toLegacyUser(rows[0]!));
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
  return c.json(toLegacyUser(updated));
});

users.get("/:user_id/api-key", async (c) => {
  const userId = c.req.param("user_id");

  const existing = await db
    .select()
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (existing.length === 0) throw new NotFoundError("User not found");

  const keys = await db
    .select()
    .from(authKey)
    .where(eq(authKey.userId, userId));

  return c.json(keys.map(toLegacyAuthKey));
});

users.post("/:user_id/api-key", async (c) => {
  const userId = c.req.param("user_id");

  // Verify user exists
  const existing = await db
    .select()
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (existing.length === 0) throw new NotFoundError("User not found");

  const newKey = generateApiKey();
  const newKeyHash = await sha256Hex(newKey);
  const [row] = await db
    .insert(authKey)
    .values({ keyHash: newKeyHash, userId })
    .returning();

  return c.json(toLegacyAuthKeyCreated(row!, newKey), 201);
});

users.put("/:user_id/api-key/:key_id/reset", async (c) => {
  const userId = c.req.param("user_id");
  const keyId = c.req.param("key_id");

  // Verify user exists
  const existingUser = await db
    .select()
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (existingUser.length === 0) throw new NotFoundError("User not found");

  // Verify key exists
  const existingKey = await db
    .select()
    .from(authKey)
    .where(and(eq(authKey.id, keyId), eq(authKey.userId, userId)))
    .limit(1);
  if (existingKey.length === 0) throw new NotFoundError("API key not found");

  const newKey = generateApiKey();
  const newKeyHash = await sha256Hex(newKey);
  const [updated] = await db
    .update(authKey)
    .set({ keyHash: newKeyHash, updatedAt: new Date() })
    .where(and(eq(authKey.id, keyId), eq(authKey.userId, userId)))
    .returning();

  if (!updated) throw new NotFoundError("API key not found");
  return c.json(toLegacyAuthKeyCreated(updated, newKey));
});

users.delete(
  "/:user_id/api-key",
  zValidator("json", deleteKeySchema),
  async (c) => {
    const userId = c.req.param("user_id");
    const { id } = c.req.valid("json");

    const deleted = await db
      .delete(authKey)
      .where(and(eq(authKey.id, id), eq(authKey.userId, userId)))
      .returning();

    if (deleted.length === 0) throw new NotFoundError("API key not found");
    return c.body(null, 204);
  },
);

const resetPasswordSchema = z.object({ password: z.string().min(6) });

users.post(
  "/:user_id/reset-password",
  zValidator("json", resetPasswordSchema),
  async (c) => {
    const userId = c.req.param("user_id");
    const { password } = c.req.valid("json");

    // Verify user exists
    const existing = await db
      .select()
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (existing.length === 0) throw new NotFoundError("User not found");

    // Update password hash in Better Auth account table
    const hash = await hashPassword(password);
    const updated = await db
      .update(account)
      .set({ password: hash, updatedAt: new Date() })
      .where(
        and(eq(account.userId, userId), eq(account.providerId, "credential")),
      )
      .returning();

    if (updated.length === 0) {
      throw new NotFoundError("No credential account found for user");
    }

    return c.body(null, 204);
  },
);

users.delete("/:user_id", async (c) => {
  const userId = c.req.param("user_id");

  // Verify user exists
  const existing = await db
    .select()
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (existing.length === 0) throw new NotFoundError("User not found");

  // Block deletion if the user appears as reviewer/creator/owner on any
  // attribution row — those are immutable audit references on inquiry
  // and recovery records. FK action is NO ACTION by design; instead of
  // a generic 500 from the FK violation, return a clear 409.
  const refs = await db
    .select({ id: attribution.id })
    .from(attribution)
    .where(
      or(
        eq(attribution.reviewer, userId),
        eq(attribution.creator, userId),
        eq(attribution.owner, userId),
      ),
    )
    .limit(1);
  if (refs.length > 0) {
    throw new ConflictError(
      "User has historic attribution records (reviewer/creator/owner of inquiries or recoveries) and cannot be deleted.",
    );
  }

  // Cascade: remove org memberships, API keys, sessions, then user
  await db.delete(organizationUser).where(eq(organizationUser.userId, userId));
  await db.delete(authKey).where(eq(authKey.userId, userId));
  await db.delete(session).where(eq(session.userId, userId));
  await db.delete(account).where(eq(account.userId, userId));
  await db.delete(user).where(eq(user.id, userId));

  return c.body(null, 204);
});

export default users;
