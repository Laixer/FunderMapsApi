import { describe, expect, test } from "bun:test";
import { parseEnumArray } from "./pg-enum-array.ts";

describe("parseEnumArray (API #128)", () => {
  test("the literal postgres.js returns for an enum array", () => {
    expect(parseEnumArray("{drystand,drainage}")).toEqual(["drystand", "drainage"]);
    expect(parseEnumArray("{}")).toEqual([]);
  });
  test("an already parsed array passes through", () => {
    expect(parseEnumArray(["drystand"])).toEqual(["drystand"]);
  });
  test("null / undefined / garbage are empty", () => {
    expect(parseEnumArray(null)).toEqual([]);
    expect(parseEnumArray(undefined)).toEqual([]);
    expect(parseEnumArray(42)).toEqual([]);
  });
  test("quoted elements", () => {
    expect(parseEnumArray('{"bio_infection",drystand}')).toEqual(["bio_infection", "drystand"]);
  });
});
