import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { markSameFile } = await import("./existing-rapportages.ts");

const row = (id: number, size: number | string | null) => ({
  id,
  type: "foundation_research",
  document_date: "2026-09-02",
  document_name: `rapport-${id}.pdf`,
  audit_status: "done",
  size_bytes: size,
  addresses: "3",
  samples: 4,
});

describe("markSameFile", () => {
  test("a rapportage with the same byte size as a dossier document is the same file", () => {
    const [same, other] = markSameFile([row(158274, 9299866), row(157951, 8609707)], [9299866]);
    expect(same!.sameFile).toBe(true);
    expect(other!.sameFile).toBe(false);
  });

  test("bigint sizes arrive as strings and still match", () => {
    expect(markSameFile([row(1, "9299866")], [9299866])[0]!.sameFile).toBe(true);
  });

  test("no size (an upload from before file_resources) is never the same file", () => {
    expect(markSameFile([row(1, null)], [9299866])[0]!.sameFile).toBe(false);
  });

  test("an empty or missing document size matches nothing", () => {
    expect(markSameFile([row(1, 0)], [0, null, undefined])[0]!.sameFile).toBe(false);
  });

  test("counts come back as numbers", () => {
    const [r] = markSameFile([row(1, null)], []);
    expect(r!.addresses).toBe(3);
    expect(r!.samples).toBe(4);
  });
});
