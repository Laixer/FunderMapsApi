import { describe, test, expect } from "bun:test";
import { ENUM_NAMES, enumEntries, intToEnum, enumToInt } from "./inquiry-enums.ts";
import snapshot from "./enum-contract.snapshot.json" with { type: "json" };

// The bimaps in inquiry-enums.ts are the hinge between three parties that
// each hold their own copy of the same enum:
//
//   ClientApp  sends an integer   (sampleEnums.ts option lists)
//   this API   maps int <-> string (inquiry-enums.ts, the file under test)
//   Postgres   stores a label      (report.* / application.* enum types)
//
// Nothing enforced that they agree, and in July 2026 two had silently
// drifted: ClientApp offered constructionPile as Hout/Beton (2 options,
// a material) while the API and DB treat it as a 7-value damage taxonomy
// (punched/broken/pinched/...), so picking "Hout" wrote `punched`. Same
// shape of bug on woodQuality, where the UI showed a quality scale over a
// column that stores zone classifications (area1..area4). 923 and 287
// production rows respectively — small only because the fields are rarely
// filled in. An automated ingest pipeline writing through the same path
// would not have been so forgiving.
//
// The two upstream sources of truth live outside this repo and outside CI:
// the integer comes from the C# enum member value (FunderMaps.Core/Types),
// the string from the PG enum label. So scripts/refresh-enum-snapshot.ts
// freezes both into enum-contract.snapshot.json and this test diffs the
// bimaps against it — no database, no C# checkout, no network.
//
// A failure here means one of:
//   - a bimap was edited by hand and now disagrees with C#/PG
//   - a PG or C# enum gained/lost/renumbered a member and the snapshot is
//     stale -> re-run the refresh script and commit the result
//
// It does NOT cover ClientApp's option lists; those live in another repo.
// Closing that third side means generating sampleEnums.ts from this
// snapshot, which is the natural follow-up.

const snapshotNames = Object.keys(snapshot.enums).sort();

describe("enum contract", () => {
  test("snapshot covers exactly the bimaps that exist", () => {
    // Guards both directions: a new bimap added without refreshing the
    // snapshot, and a bimap deleted while its snapshot entry lingers.
    expect(snapshotNames).toEqual([...ENUM_NAMES].sort());
  });

  describe.each(snapshotNames)("%s", (name) => {
    const entry = snapshot.enums[name as keyof typeof snapshot.enums];

    test("int/string pairs match C# member values and PG labels", () => {
      const actual = enumEntries(name as never).sort((a, b) => a[0] - b[0]);
      expect(actual).toEqual(entry.expectedPairs as [number, string][]);
    });

    test("no duplicate ints or strings", () => {
      // bimap() builds its reverse map by inserting each pair in order, so a
      // repeated string silently collapses two ints into one and a repeated
      // int silently drops a string. Neither throws at construction.
      const pairs = enumEntries(name as never);
      expect(new Set(pairs.map(([i]) => i)).size).toBe(pairs.length);
      expect(new Set(pairs.map(([, s]) => s)).size).toBe(pairs.length);
    });

    test("round-trips int -> string -> int", () => {
      for (const [int] of entry.expectedPairs as [number, string][]) {
        const asString = intToEnum(name as never, int);
        expect(asString).not.toBeNull();
        expect(enumToInt(name as never, asString)).toBe(int);
      }
    });

    test("rejects a value outside the enum", () => {
      const ints = (entry.expectedPairs as [number, string][]).map(([i]) => i);
      const unused = Math.max(...ints) + 1;
      expect(() => intToEnum(name as never, unused)).toThrow();
      expect(() => enumToInt(name as never, "definitely_not_a_label")).toThrow();
    });
  });
});
