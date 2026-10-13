import { describe, test, expect } from "bun:test";
import { documentDateProblem, resolveDocumentDate } from "./document-date.ts";

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

describe("documentDateProblem", () => {
  const today = new Date("2026-10-12T20:00:00Z");

  test("the slip that reached the database: 2926 for 2026", () => {
    expect(documentDateProblem("2926-05-15", today)).toContain("2926-05-15");
    expect(documentDateProblem("2926-05-15", today)).toContain("toekomst");
  });

  test("a date a little past today is real: the QuickScan feed delivers them", () => {
    expect(documentDateProblem("2026-10-13", today)).toBeNull();
    expect(documentDateProblem("2026-11-06", today)).toBeNull();
    expect(documentDateProblem("2028-11-19", today)).toBeNull();
    expect(documentDateProblem("2036-12-31", today)).toBeNull();
  });

  test("the first impossible year is ten past this one", () => {
    expect(documentDateProblem("2037-01-01", today)).not.toBeNull();
  });

  test("old documents are fine: an archive drawing gets its construction year", () => {
    expect(documentDateProblem("1367-01-01", today)).toBeNull();
    expect(documentDateProblem("1911-05-12", today)).toBeNull();
  });

  test("a value with a time attached is read by its day", () => {
    expect(documentDateProblem("2026-10-12T00:00:00.000Z", today)).toBeNull();
    expect(documentDateProblem("2926-05-15T00:00:00.000Z", today)).toContain("2926-05-15");
  });

  test("what is not a date is not judged here: the format check says that", () => {
    expect(documentDateProblem("gisteren", today)).toBeNull();
    expect(documentDateProblem("1-5-2024", today)).toBeNull();
    expect(documentDateProblem("", today)).toBeNull();
    expect(documentDateProblem(null, today)).toBeNull();
    expect(documentDateProblem(undefined, today)).toBeNull();
  });
});
