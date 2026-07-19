import { describe, test, expect } from "bun:test";

// config.ts parses process.env at import time; give it the required keys
// before auth-helpers pulls it in. The db client it also imports is lazy —
// no connection is made without a query.
process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { isPlatformMember } = await import("./auth-helpers.ts");

// FunderMaps B.V. — the default PLATFORM_ORGANIZATION_ID in config.ts.
// Members are invoer staff with cross-org access to inquiry/recovery data;
// changing the default is an access-control change and must show up here.
const PLATFORM_ORG = "d8c19418-c832-4c91-8993-84b8ed641448";

describe("isPlatformMember", () => {
  test("member of the platform org", () => {
    expect(
      isPlatformMember({ organizations: [{ id: PLATFORM_ORG }] }),
    ).toBe(true);
  });

  test("platform org among multiple memberships", () => {
    expect(
      isPlatformMember({
        organizations: [
          { id: "11111111-1111-1111-1111-111111111111" },
          { id: PLATFORM_ORG },
        ],
      }),
    ).toBe(true);
  });

  test("customer-org-only user", () => {
    expect(
      isPlatformMember({
        organizations: [{ id: "11111111-1111-1111-1111-111111111111" }],
      }),
    ).toBe(false);
  });

  test("no organizations", () => {
    expect(isPlatformMember({ organizations: [] })).toBe(false);
  });
});
