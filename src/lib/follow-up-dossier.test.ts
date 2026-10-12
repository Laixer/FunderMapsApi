import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { followUpValues, isClosed, sourceLabel } = await import("./follow-up-dossier.ts");

describe("isClosed", () => {
  test("an outcome or a commit closes a dossier; neither leaves it open", () => {
    expect(isClosed({ outcome: "rejected", inquiryId: null })).toBe(true);
    expect(isClosed({ outcome: null, inquiryId: 42 })).toBe(true);
    expect(isClosed({ outcome: null, inquiryId: null })).toBe(false);
  });
});

describe("followUpValues", () => {
  test("subject and back-link name the old meldcode", () => {
    const { subject, payload } = followUpValues({ id: 6168, reference: "FM2026-000494" }, "  Hierbij het rapport.  ");
    expect(subject).toBe("Aanvullende stukken bij FM2026-000494");
    expect(payload).toEqual({
      topic: "follow_up",
      topicLabel: "Aanvullende stukken",
      note: "Hierbij het rapport.",
      source: "reply",
      follow_up_of: { dossier_id: 6168, reference: "FM2026-000494" },
    });
    // A continuation, not a duplicate.
    expect(payload).not.toHaveProperty("duplicate_of");
  });

  test("no reference: the dossier id stands in; empty reply: no note", () => {
    const { subject, payload } = followUpValues({ id: 12, reference: null }, "   ");
    expect(subject).toBe("Aanvullende stukken bij melding 12");
    expect(payload.note).toBeNull();
    expect(sourceLabel({ id: 12, reference: null })).toBe("melding 12");
  });

  test("a long reply is capped like the intake form's note", () => {
    expect(followUpValues({ id: 1, reference: "FM2026-000001" }, "x".repeat(9000)).payload.note).toHaveLength(5000);
  });
});
