import { describe, expect, test } from "bun:test";
import { groupAssignments, MAX_PACKAGES, normalizePackageIds, validateWorkPackageBody } from "./work-packages.ts";

describe("validateWorkPackageBody", () => {
  test("a list of Studio package ids passes", () => {
    expect(validateWorkPackageBody({ packageIds: ["meldingen-funderingstype", "archiefverwerking", "vragen"] })).toEqual([]);
  });
  test("an empty list passes: it clears the set and the user picks their own again", () => {
    expect(validateWorkPackageBody({ packageIds: [] })).toEqual([]);
  });
  test("the body must carry packageIds as an array", () => {
    expect(validateWorkPackageBody(null)).toHaveLength(1);
    expect(validateWorkPackageBody([])).toHaveLength(1);
    expect(validateWorkPackageBody({})).toEqual([expect.stringContaining("packageIds must be an array")]);
    expect(validateWorkPackageBody({ packageIds: "vragen" })).toHaveLength(1);
  });
  test("each id must be slug-shaped, the same pattern as the table's CHECK", () => {
    const errors = validateWorkPackageBody({ packageIds: ["ok-1", "Hoofdletter", "", 7, "a".repeat(65), "x'; drop"] });
    expect(errors).toEqual([
      expect.stringContaining("packageIds[1]"),
      expect.stringContaining("packageIds[2]"),
      expect.stringContaining("packageIds[3]"),
      expect.stringContaining("packageIds[4]"),
      expect.stringContaining("packageIds[5]"),
    ]);
  });
  test(`at most ${MAX_PACKAGES} ids`, () => {
    const ids = Array.from({ length: MAX_PACKAGES + 1 }, (_, i) => `p-${i}`);
    expect(validateWorkPackageBody({ packageIds: ids })).toEqual([expect.stringContaining(`at most ${MAX_PACKAGES}`)]);
    expect(validateWorkPackageBody({ packageIds: ids.slice(1) })).toEqual([]);
  });
});

describe("normalizePackageIds", () => {
  test("folds duplicates and sorts", () => {
    expect(normalizePackageIds(["vragen", "reacties", "vragen"])).toEqual(["reacties", "vragen"]);
  });
});

describe("groupAssignments", () => {
  test("one entry per user, ids sorted, users in first-seen order", () => {
    const rows = [
      { userId: "b", packageId: "vragen" },
      { userId: "a", packageId: "reacties" },
      { userId: "b", packageId: "archiefverwerking" },
    ];
    expect(groupAssignments(rows)).toEqual([
      { userId: "b", packageIds: ["archiefverwerking", "vragen"] },
      { userId: "a", packageIds: ["reacties"] },
    ]);
  });
  test("no rows, no entries", () => {
    expect(groupAssignments([])).toEqual([]);
  });
});
