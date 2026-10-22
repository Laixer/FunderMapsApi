import { describe, expect, test } from "bun:test";
import { addUp, flowBucket, weekly, type FlowFacts } from "./dataops-flow.ts";

const open: FlowFacts = { inquiry: false, outcome: null, files: true, read: true, found: true, open: true };

describe("flowBucket", () => {
  test("a rapportage wins over the outcome it was closed with", () => {
    expect(flowBucket({ ...open, inquiry: true, outcome: "accepted" })).toBe("rapportage");
    expect(flowBucket({ ...open, inquiry: true, outcome: "no_data" })).toBe("rapportage");
    expect(flowBucket({ ...open, inquiry: true })).toBe("rapportage");
  });

  test("closed without a rapportage: the outcome", () => {
    for (const outcome of ["accepted", "no_data", "rejected", "duplicate"]) {
      expect(flowBucket({ ...open, outcome })).toBe(outcome as ReturnType<typeof flowBucket>);
    }
  });

  test("an outcome nobody gave a place is refused, not counted as another", () => {
    expect(() => flowBucket({ ...open, outcome: "withdrawn" })).toThrow("unknown dossier outcome: withdrawn");
  });

  test("open, in pipeline order", () => {
    expect(flowBucket({ ...open, files: false, read: false, found: false, open: false })).toBe("question");
    expect(flowBucket({ ...open, read: false, found: false, open: false })).toBe("unread");
    expect(flowBucket({ ...open, found: false, open: false })).toBe("empty");
    expect(flowBucket(open)).toBe("proposals");
    expect(flowBucket({ ...open, open: false })).toBe("judged");
  });
});

describe("addUp", () => {
  test("groups that land in one bucket are added; pipeline order; nothing empty", () => {
    const rows = addUp([
      { ...open, channel: "upload", count: 3 },
      { ...open, channel: "upload", inquiry: true, outcome: "accepted", count: 5 },
      { ...open, channel: "upload", inquiry: true, outcome: "no_data", count: 1 },
      { ...open, channel: "bulk_drop", outcome: "no_data", count: 7 },
      { ...open, channel: "upload", outcome: "rejected", count: 0 },
    ]);
    expect(rows).toEqual([
      { channel: "bulk_drop", bucket: "no_data", count: 7 },
      { channel: "upload", bucket: "rapportage", count: 6 },
      { channel: "upload", bucket: "proposals", count: 3 },
    ]);
  });
});

describe("weekly", () => {
  test("every week for every channel, zero where nothing happened", () => {
    const rows = weekly(
      ["2026-10-05", "2026-10-12"],
      [{ week: "2026-10-12", channel: "upload", count: 4 }],
      [{ week: "2026-10-05", channel: "audit", count: 2 }],
    );
    expect(rows).toEqual([
      { week: "2026-10-05", channel: "audit", received: 0, closed: 2 },
      { week: "2026-10-12", channel: "audit", received: 0, closed: 0 },
      { week: "2026-10-05", channel: "upload", received: 0, closed: 0 },
      { week: "2026-10-12", channel: "upload", received: 4, closed: 0 },
    ]);
  });
});
