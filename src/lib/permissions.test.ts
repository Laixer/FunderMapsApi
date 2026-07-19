import { describe, test, expect } from "bun:test";
import { reader, writer, verifier, superuser, roles } from "./permissions.ts";

// The four fixed roles must keep the legacy C# policy semantics that
// auth-helpers.ts enforced with role sets before Phase 2:
//   WRITE_ROLES  = writer, verifier, superuser
//   REVIEW_ROLES = verifier, superuser
//   ADMIN_ROLES  = superuser (delete, assign-owner)
// A change here is an access-control change for every customer org.

function can(
  role: { statements: Partial<Record<string, readonly string[]>> },
  resource: string,
  action: string,
): boolean {
  return role.statements[resource]?.includes(action) ?? false;
}

describe("fixed org roles", () => {
  test("role names match organization_user.role values", () => {
    expect(Object.keys(roles).sort()).toEqual([
      "reader",
      "superuser",
      "verifier",
      "writer",
    ]);
  });

  for (const resource of ["inquiry", "recovery"]) {
    test(`${resource}: write requires writer+`, () => {
      expect(can(reader, resource, "write")).toBe(false);
      expect(can(writer, resource, "write")).toBe(true);
      expect(can(verifier, resource, "write")).toBe(true);
      expect(can(superuser, resource, "write")).toBe(true);
    });

    test(`${resource}: review requires verifier+`, () => {
      expect(can(reader, resource, "review")).toBe(false);
      expect(can(writer, resource, "review")).toBe(false);
      expect(can(verifier, resource, "review")).toBe(true);
      expect(can(superuser, resource, "review")).toBe(true);
    });

    test(`${resource}: delete and assign-owner are superuser-only`, () => {
      for (const action of ["delete", "assign-owner"]) {
        expect(can(reader, resource, action)).toBe(false);
        expect(can(writer, resource, action)).toBe(false);
        expect(can(verifier, resource, action)).toBe(false);
        expect(can(superuser, resource, action)).toBe(true);
      }
    });
  }

  test("every role can read and access the app", () => {
    for (const role of [reader, writer, verifier, superuser]) {
      expect(can(role, "inquiry", "read")).toBe(true);
      expect(can(role, "recovery", "read")).toBe(true);
      expect(can(role, "app", "access")).toBe(true);
    }
  });

  test("only superuser manages members and dynamic roles", () => {
    expect(can(superuser, "member", "create")).toBe(true);
    expect(can(superuser, "ac", "create")).toBe(true);
    for (const role of [reader, writer, verifier]) {
      expect(can(role, "member", "create")).toBe(false);
      expect(can(role, "ac", "create")).toBe(false);
    }
  });
});
