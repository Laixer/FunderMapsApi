import { describe, expect, test } from "bun:test";
import { closingNoteText } from "./closing-note.ts";

describe("closingNoteText", () => {
  test("nothing written: null, so the caller keeps its default", () => {
    expect(closingNoteText([{ documents: ["rapport.pdf"], verdict: "accepted", answer: null }])).toBeNull();
    expect(closingNoteText([{ documents: ["rapport.pdf"], verdict: "accepted", answer: "  " }], "  ")).toBeNull();
  });

  test("only a Reden: the Reden", () => {
    expect(closingNoteText([{ documents: ["rapport.pdf"], verdict: "accepted", answer: null }], " Bedankt voor uw rapport. ")).toBe("Bedankt voor uw rapport.");
  });

  test("one paragraph per answered rapportage, named by its documents and its verdict", () => {
    expect(
      closingNoteText([
        { documents: ["onderzoek.pdf", "foto.jpg"], verdict: "accepted", answer: "Het onderzoek is overgenomen." },
        { documents: ["tekening.pdf"], verdict: "rejected", answer: "Dit is geen funderingsdocument." },
        { documents: ["bijlage.pdf"], verdict: "accepted", answer: null },
      ]),
    ).toBe("onderzoek.pdf, foto.jpg (overgenomen): Het onderzoek is overgenomen.\n\ntekening.pdf (niet overgenomen): Dit is geen funderingsdocument.");
  });

  test("answers and a Reden both reach the melder, the Reden last", () => {
    expect(
      closingNoteText([{ documents: ["tekening.pdf"], verdict: "rejected", answer: "Dit is geen funderingsdocument." }], "U kunt een nieuw rapport insturen."),
    ).toBe("tekening.pdf (niet overgenomen): Dit is geen funderingsdocument.\n\nU kunt een nieuw rapport insturen.");
  });
});
