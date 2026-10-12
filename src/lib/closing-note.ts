/**
 * The closing note the melder reads after a commit: one paragraph per
 * rapportage that got an answer, named by its documents (the melder knows no
 * "Inquiry 2"), then the reviewer's Reden about the dossier as a whole.
 * Null when the reviewer wrote nothing; the caller then keeps its default.
 */
export function closingNoteText(
  rapportages: { documents: string[]; verdict: "accepted" | "rejected"; answer: string | null }[],
  closingNote?: string | null,
): string | null {
  const paragraphs = rapportages
    .filter((r) => r.answer?.trim())
    .map((r) => `${r.documents.join(", ")} (${r.verdict === "accepted" ? "overgenomen" : "niet overgenomen"}): ${r.answer!.trim()}`);
  const reden = closingNote?.trim();
  if (reden) paragraphs.push(reden);
  return paragraphs.join("\n\n") || null;
}
