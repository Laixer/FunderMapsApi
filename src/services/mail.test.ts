import { describe, test, expect } from "bun:test";

// config.ts parses process.env at import time; none of this sends mail.
process.env.DATABASE_URL ??= "postgres://test@localhost:5432/test";
process.env.APP_ID ??= "ci-test-app";
process.env.AUTH_SECRET ??= "ci-test-secret-not-used-for-anything-real";

const { dropSkipped } = await import("./mail");

const skip = new Set(["feed-reviewer@example.com", "service@example.org"]);

describe("dropSkipped", () => {
  test("drops a bare address on the list", () => {
    expect(dropSkipped(["feed-reviewer@example.com"], skip)).toEqual({
      keep: [],
      dropped: ["feed-reviewer@example.com"],
    });
  });

  test("matches the address inside a display-name recipient", () => {
    const r = "Feed Reviewer <feed-reviewer@example.com>";
    expect(dropSkipped([r], skip)).toEqual({ keep: [], dropped: [r] });
  });

  test("is case- and whitespace-insensitive on the address", () => {
    const r = "Service <  SERVICE@Example.ORG >";
    expect(dropSkipped([r], skip).dropped).toEqual([r]);
  });

  test("keeps everyone else, in order", () => {
    const to = ["A <a@example.com>", "Feed Reviewer <feed-reviewer@example.com>", "b@example.com"];
    expect(dropSkipped(to, skip)).toEqual({
      keep: ["A <a@example.com>", "b@example.com"],
      dropped: ["Feed Reviewer <feed-reviewer@example.com>"],
    });
  });

  test("does not match on a substring of a listed address", () => {
    expect(dropSkipped(["x-feed-reviewer@example.com"], skip).keep).toEqual(["x-feed-reviewer@example.com"]);
  });

  test("an empty list keeps everything", () => {
    expect(dropSkipped(["a@example.com"], new Set()).keep).toEqual(["a@example.com"]);
  });
});
