import { describe, test, expect } from "bun:test";
import { assertReviewerAllowed } from "./reviewer-rule.ts";
import { ForbiddenError } from "./errors.ts";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const EDITOR = "22222222-2222-4222-8222-222222222222";
const COLLEAGUE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("assertReviewerAllowed", () => {
  test("a third colleague may review", () => {
    expect(() => assertReviewerAllowed(COLLEAGUE, CREATOR, CREATOR)).not.toThrow();
    expect(() => assertReviewerAllowed(COLLEAGUE, CREATOR, EDITOR)).not.toThrow();
  });

  test("create: the caller is the creator and may not review their own report", () => {
    expect(() => assertReviewerAllowed(CREATOR, CREATOR, CREATOR)).toThrow("Reviewer must differ from creator");
  });

  test("update by a colleague: the stored creator may still not review", () => {
    // What the database refuses (creator_reviewer_chk): the editor is someone
    // else, so a caller-only check lets this through to a 500.
    expect(() => assertReviewerAllowed(CREATOR, CREATOR, EDITOR)).toThrow("Reviewer must differ from creator");
  });

  test("update by a colleague: the editor may not name themselves either", () => {
    expect(() => assertReviewerAllowed(EDITOR, CREATOR, EDITOR)).toThrow("Reviewer must differ from the user making the change");
  });

  test("refusals are a 403, not a 500", () => {
    try {
      assertReviewerAllowed(CREATOR, CREATOR, EDITOR);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).statusCode).toBe(403);
    }
  });

  test("an uppercase id in the body is the same user", () => {
    expect(() => assertReviewerAllowed(CREATOR.toUpperCase(), CREATOR, EDITOR)).toThrow(ForbiddenError);
    expect(() => assertReviewerAllowed(EDITOR.toUpperCase(), CREATOR, EDITOR)).toThrow(ForbiddenError);
  });
});
