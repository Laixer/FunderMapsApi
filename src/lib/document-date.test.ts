import { describe, test, expect } from "bun:test";
import { resolveDocumentDate } from "./document-date.ts";

describe("resolveDocumentDate", () => {
  test("the reviewer's date wins", () => {
    expect(resolveDocumentDate({ explicit: "1954-03-01", judged: "1911-05-12", type: "archive_research", builtYear: "1910-01-01" }))
      .toEqual({ date: "1954-03-01", source: "explicit" });
  });

  test("then the date read from the document", () => {
    expect(resolveDocumentDate({ judged: "1911-05-12", type: "foundation_research", builtYear: "1910-01-01" }))
      .toEqual({ date: "1911-05-12", source: "document" });
  });

  test("archive drawing without a date: the construction year, 1 January, flagged", () => {
    expect(resolveDocumentDate({ type: "archive_research", builtYear: "1910-01-01" }))
      .toEqual({ date: "1910-01-01", source: "built_year" });
    expect(resolveDocumentDate({ type: "architectural_research", builtYear: "1887-07-15" }))
      .toEqual({ date: "1887-01-01", source: "built_year" });
  });

  test("any other kind without a date: nothing, the reviewer must fill it", () => {
    expect(resolveDocumentDate({ type: "foundation_research", builtYear: "1910-01-01" })).toBeNull();
    expect(resolveDocumentDate({ type: "quickscan" })).toBeNull();
  });

  test("archive drawing without a construction year: nothing either", () => {
    expect(resolveDocumentDate({ type: "archive_research", builtYear: null })).toBeNull();
    expect(resolveDocumentDate({ type: "archive_research", builtYear: "0000-01-01" })).toBeNull();
  });

  test("malformed dates are ignored, not trusted", () => {
    expect(resolveDocumentDate({ explicit: "12-05-1911", judged: "1911", type: "archive_research", builtYear: "1910-01-01" }))
      .toEqual({ date: "1910-01-01", source: "built_year" });
  });
});
