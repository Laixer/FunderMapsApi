// One-shot admin seeder for the local dev VM.
// Mirrors the Drizzle-direct pattern from src/routes/management/user.ts.

import { db } from "../src/db/client.ts";
import { user, account } from "../src/db/schema/application.ts";
import { hashPassword } from "better-auth/crypto";

const email = process.env.SEED_ADMIN_EMAIL ?? "admin@local.test";
const password = process.env.SEED_ADMIN_PASSWORD ?? "AdminPassword12345!";

const [created] = await db
  .insert(user)
  .values({
    name: "Local Admin",
    email,
    emailVerified: true,
    role: "administrator",
  })
  .returning();

if (!created) throw new Error("user insert returned no row");

const passwordHash = await hashPassword(password);

await db.insert(account).values({
  id: crypto.randomUUID(),
  userId: created.id,
  accountId: created.id,
  providerId: "credential",
  password: passwordHash,
});

console.log(JSON.stringify({ id: created.id, email, password }, null, 2));
process.exit(0);
