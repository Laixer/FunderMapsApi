import { describe, expect, test } from "bun:test";
import { personLabel, seriesByKey } from "./reader-ops.ts";

describe("seriesByKey", () => {
  const days = ["2026-10-21", "2026-10-22", "2026-10-23"];

  test("counts: zero where a day had nothing; bigint strings and repeats add up", () => {
    const out = seriesByKey(days, [
      { day: "2026-10-21", key: "document", value: "4" },
      { day: "2026-10-21", key: "document", value: 1 },
      { day: "2026-10-23", key: "vision", value: 2 },
      { day: "2026-10-01", key: "document", value: 9 },
      { day: "2026-10-22", key: "unknown", value: 9 },
    ], ["document", "vision"], 0);
    expect(out.document).toEqual([5, 0, 0]);
    expect(out.vision).toEqual([0, 0, 2]);
    expect(out.unknown).toBeUndefined();
  });

  test("durations: null where a day had no read, not a zero that looks fast", () => {
    const out = seriesByKey(days, [{ day: "2026-10-22", key: "p50", value: 41.5 }, { day: "2026-10-23", key: "p50", value: null }], ["p50"], null);
    expect(out.p50).toEqual([null, 41.5, null]);
  });
});

describe("personLabel", () => {
  test("name, else the e-mail's first part", () => {
    expect(personLabel({ name: null, givenName: "Anna", lastName: "Maker", email: "anna@x.test" })).toBe("Anna Maker");
    expect(personLabel({ name: "Bram", givenName: null, lastName: null, email: "b@x.test" })).toBe("Bram");
    expect(personLabel({ name: null, givenName: null, lastName: null, email: "don@x.test" })).toBe("don");
    expect(personLabel({ name: null, givenName: null, lastName: null, email: null })).toBe("onbekend");
  });
});
