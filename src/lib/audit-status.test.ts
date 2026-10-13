import { describe, expect, test } from "bun:test";
import { transitionStatus, WRITABLE_STATES } from "./audit-status.ts";
import { ValidationError } from "./errors.ts";

describe("transitionStatus", () => {
  test("a record that can still be edited can be offered for review", () => {
    for (const from of WRITABLE_STATES) expect(transitionStatus(from, "pending_review")).toBe("pending_review");
    // No status yet counts as todo.
    expect(transitionStatus(null, "pending_review")).toBe("pending_review");
  });
  test("a locked record cannot be offered again", () => {
    for (const from of ["pending_review", "done", "discarded"]) {
      expect(() => transitionStatus(from, "pending_review")).toThrow(ValidationError);
    }
  });
  test("approving and rejecting need a record that is under review", () => {
    expect(transitionStatus("pending_review", "done")).toBe("done");
    expect(transitionStatus("pending_review", "rejected")).toBe("rejected");
    for (const from of ["todo", "pending", "rejected", "done"]) {
      expect(() => transitionStatus(from, "done")).toThrow(ValidationError);
      expect(() => transitionStatus(from, "rejected")).toThrow(ValidationError);
    }
  });
  test("back to pending from anywhere; back to todo only from pending", () => {
    for (const from of ["todo", "pending", "pending_review", "done", "rejected", null]) {
      expect(transitionStatus(from, "pending")).toBe("pending");
    }
    expect(transitionStatus("pending", "todo")).toBe("todo");
    expect(() => transitionStatus("done", "todo")).toThrow(ValidationError);
  });
  test("the refusal names both states", () => {
    let caught: unknown;
    try { transitionStatus("done", "pending_review"); } catch (e) { caught = e; }
    expect((caught as ValidationError).errors).toEqual(["Illegal audit-status transition: done → pending_review"]);
  });
});
