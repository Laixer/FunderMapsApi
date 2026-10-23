import { describe, expect, test } from "bun:test";
import { nowOnlyFilters } from "./queue-trend.ts";

describe("nowOnlyFilters", () => {
  test("a dossier's own facts may be drawn over time", () => {
    expect(nowOnlyFilters({ channel: "upload", q: "Iets anders", kind: "archive_research", municipality: "GM0363" })).toEqual([]);
  });

  test("how a dossier stands now may not, and each one is named", () => {
    expect(nowOnlyFilters({ channel: "upload", state: "question" })).toEqual(["state"]);
    expect(nowOnlyFilters({ age: "overdue", assignedTo: "me", outcome: "rejected", scope: "all" })).toEqual(["age", "assignedTo", "outcome", "scope"]);
  });

  test("an empty parameter is no filter", () => {
    expect(nowOnlyFilters({ state: "", assignedTo: "  " })).toEqual([]);
  });
});
