import { describe, expect, test } from "bun:test";
import { listPage } from "./pagination.ts";

const page = (qs: Record<string, string>, def = 100) => listPage((name) => qs[name], def);

describe("listPage", () => {
  test("nothing given: the default page from the start", () => {
    expect(page({})).toEqual({ limit: 100, offset: 0 });
    expect(page({}, 500)).toEqual({ limit: 500, offset: 0 });
  });

  test("valid values pass through, large ones too", () => {
    expect(page({ limit: "20", offset: "40" })).toEqual({ limit: 20, offset: 40 });
    expect(page({ limit: "100000" })).toEqual({ limit: 100000, offset: 0 });
  });

  test("a limit that is not a positive whole number is the default, not the whole table", () => {
    for (const bad of ["abc", "-1", "0", "1.5", "", " ", "1e9", "99999999999999999999"]) {
      expect(page({ limit: bad })).toEqual({ limit: 100, offset: 0 });
    }
  });

  test("an offset that is not a whole number from 0 is the start, not a database error", () => {
    for (const bad of ["-1", "abc", "2.5", "99999999999999999999"]) {
      expect(page({ limit: "20", offset: bad })).toEqual({ limit: 20, offset: 0 });
    }
    expect(page({ offset: "0" })).toEqual({ limit: 100, offset: 0 });
  });
});
