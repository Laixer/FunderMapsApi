import { describe, test, expect } from "bun:test";
import { assertReviewerAllowed } from "./reviewer-rule.ts";
import { ForbiddenError } from "./errors.ts";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const EDITOR = "22222222-2222-4222-8222-222222222222";
const COLLEAGUE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("assertReviewerAllowed", () => {
  test("a third colleague may review", () => {
    expect(() => assertReviewerAllowed(COLLEAGUE, CREATOR)).not.toThrow();
  });

  test("create: the caller is the creator and may not review their own report", () => {
    expect(() => assertReviewerAllowed(CREATOR, CREATOR)).toThrow("Reviewer must differ from creator");
  });

  test("update by a colleague: the stored creator may still not review", () => {
    // What the database refuses (creator_reviewer_chk).
    expect(() => assertReviewerAllowed(CREATOR, CREATOR)).toThrow("Reviewer must differ from creator");
  });

  test("update: the stored reviewer may save their own edit (API #245)", () => {
    // The editor is the reviewer, not the creator: allowed since 2026-10-26.
    expect(() => assertReviewerAllowed(EDITOR, CREATOR)).not.toThrow();
  });

  test("refusals are a 403, not a 500", () => {
    try {
      assertReviewerAllowed(CREATOR, CREATOR);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).statusCode).toBe(403);
    }
  });

  test("an uppercase id in the body is the same user", () => {
    expect(() => assertReviewerAllowed(CREATOR.toUpperCase(), CREATOR)).toThrow(ForbiddenError);
  });
});
