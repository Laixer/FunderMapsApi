import { Hono } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.ts";
import { user, applicationUser } from "../db/schema/application.ts";
import { env } from "../config.ts";
import { toLegacyUser } from "../lib/user-serializer.ts";
import type { AppEnv } from "../types/context.ts";

const users = new Hono<AppEnv>();

users.get("/me", (c) => {
  const u = c.get("user");
  return c.json(toLegacyUser(u, u.organizations));
});

const updateUserSchema = z.object({
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  picture: z.string().optional(),
  job_title: z.string().optional(),
  phone_number: z.string().optional(),
});

users.put("/me", zValidator("json", updateUserSchema), async (c) => {
  const input = c.req.valid("json");
  const currentUser = c.get("user");

  const toNullable = (v: string | undefined) =>
    v === undefined ? undefined : v === "" ? null : v;

  await db
    .update(user)
    .set({
      givenName: toNullable(input.given_name),
      lastName: toNullable(input.family_name),
      avatar: toNullable(input.picture),
      jobTitle: toNullable(input.job_title),
      phoneNumber: toNullable(input.phone_number),
    })
    .where(eq(user.id, currentUser.id));

  const [updated] = await db
    .select()
    .from(user)
    .where(eq(user.id, currentUser.id))
    .limit(1);

  return c.json(toLegacyUser(updated!, currentUser.organizations));
});

users.get("/metadata", async (c) => {
  const currentUser = c.get("user");
  const appId = c.req.query("app_id") ?? env.APP_ID;

  const rows = await db
    .select()
    .from(applicationUser)
    .where(
      and(
        eq(applicationUser.userId, currentUser.id),
        eq(applicationUser.applicationId, appId),
      ),
    )
    .limit(1);

  return c.json(rows[0] ?? {});
});

const updateMetadataSchema = z.object({
  metadata: z.record(z.string(), z.unknown()),
});

users.put("/metadata", zValidator("json", updateMetadataSchema), async (c) => {
  const { metadata } = c.req.valid("json");
  const currentUser = c.get("user");
  const appId = c.req.query("app_id") ?? env.APP_ID;

  const existing = await db
    .select()
    .from(applicationUser)
    .where(
      and(
        eq(applicationUser.userId, currentUser.id),
        eq(applicationUser.applicationId, appId),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    await db.insert(applicationUser).values({
      userId: currentUser.id,
      applicationId: appId,
      metadata,
      updateDate: new Date(),
    });
  } else {
    await db
      .update(applicationUser)
      .set({ metadata, updateDate: new Date() })
      .where(
        and(
          eq(applicationUser.userId, currentUser.id),
          eq(applicationUser.applicationId, appId),
        ),
      );
  }

  return c.body(null, 204);
});

export default users;
