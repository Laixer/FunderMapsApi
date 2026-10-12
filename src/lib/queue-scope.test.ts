import { describe, expect, test } from "bun:test";
import { ValidationError } from "./errors.ts";
import { queueScopeOf } from "./queue-scope.ts";

describe("queueScopeOf", () => {
  test("nothing asked: the desk", () => {
    expect(queueScopeOf({ outcomes: [], states: [], scope: undefined })).toEqual({ kind: "desk" });
    expect(queueScopeOf({ outcomes: [], states: ["proposals"], scope: "desk" })).toEqual({ kind: "desk" });
  });

  test("scope=all: every dossier, open or closed", () => {
    expect(queueScopeOf({ outcomes: [], states: [], scope: "all" })).toEqual({ kind: "all" });
  });

  test("state=replied spans open and closed, as before", () => {
    expect(queueScopeOf({ outcomes: [], states: ["replied"], scope: undefined })).toEqual({ kind: "all" });
  });

  test("an explicit outcome wins over scope=all and over state=replied", () => {
    expect(queueScopeOf({ outcomes: ["rejected"], states: [], scope: "all" })).toEqual({ kind: "outcomes", outcomes: ["rejected"] });
    expect(queueScopeOf({ outcomes: ["rejected", "duplicate"], states: ["replied"], scope: undefined })).toEqual({
      kind: "outcomes",
      outcomes: ["rejected", "duplicate"],
    });
  });

  test("an unknown scope or outcome is refused", () => {
    const refused = (input: Parameters<typeof queueScopeOf>[0]) => {
      try {
        queueScopeOf(input);
      } catch (e) {
        return e instanceof ValidationError ? e.errors : [`not a ValidationError: ${e}`];
      }
      return [];
    };
    expect(refused({ outcomes: [], states: [], scope: "everything" })).toEqual(["scope must be desk or all"]);
    expect(refused({ outcomes: ["lost"], states: [], scope: undefined })).toEqual(["unknown outcome: lost"]);
  });
});
