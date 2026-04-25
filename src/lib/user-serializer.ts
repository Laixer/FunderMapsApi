// Map the Drizzle-shaped (camelCase) user row into the snake_case shape
// the legacy frontends (ManagementFront, ClientApp) expect — same as
// what the Go backend produced. Keeps wire format stable across the
// Go→TS cutover.
import type { InferSelectModel } from "drizzle-orm";
import type { user } from "../db/schema/application.ts";

type UserRow = InferSelectModel<typeof user>;

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
  organizations?: { id: string; name: string }[];
}

export function toLegacyUser(
  u: UserRow,
  organizations?: { id: string; name: string }[],
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
