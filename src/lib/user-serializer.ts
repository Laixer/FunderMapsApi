// Map the Drizzle-shaped (camelCase) user row into the snake_case shape
// the legacy frontends (ManagementFront, ClientApp) expect — same as
// what the Go backend produced. Keeps wire format stable across the
// Go→TS cutover.
import type { InferSelectModel } from "drizzle-orm";
import type { user, authKey } from "../db/schema/application.ts";

type UserRow = InferSelectModel<typeof user>;
type AuthKeyRow = InferSelectModel<typeof authKey>;

export interface LegacyOrg {
  id: string;
  name: string;
  role?: string | null;
}

export interface LegacyUser {
  id: string;
  given_name: string | null;
  family_name: string | null;
  email: string;
  picture: string | null;
  job_title: string | null;
  phone_number: string | null;
  role: string;
  last_login: string | null;
  organizations?: LegacyOrg[];
}

export function toLegacyUser(
  u: UserRow,
  organizations?: LegacyOrg[],
): LegacyUser {
  return {
    id: u.id,
    given_name: u.givenName ?? null,
    family_name: u.lastName ?? null,
    email: u.email,
    picture: u.avatar ?? null,
    job_title: u.jobTitle ?? null,
    phone_number: u.phoneNumber ?? null,
    role: u.role,
    last_login: u.lastLogin ? new Date(u.lastLogin).toISOString() : null,
    ...(organizations !== undefined && { organizations }),
  };
}

export interface LegacyAuthKey {
  id: string;
  user_id: string;
  name: string | null;
  last_used: string | null;
}

export function toLegacyAuthKey(k: AuthKeyRow): LegacyAuthKey {
  return {
    id: k.id,
    user_id: k.userId,
    name: k.name ?? null,
    last_used: k.lastUsed ? new Date(k.lastUsed).toISOString() : null,
  };
}

// One-time creation response: includes the freshly generated plaintext
// key so the user can copy it. The plaintext is NOT stored — only its
// SHA-256 hash lives in the DB — so this is the only chance to surface it.
export interface LegacyAuthKeyCreated extends LegacyAuthKey {
  key: string;
}

export function toLegacyAuthKeyCreated(
  k: AuthKeyRow,
  plaintextKey: string,
): LegacyAuthKeyCreated {
  return { ...toLegacyAuthKey(k), key: plaintextKey };
}
