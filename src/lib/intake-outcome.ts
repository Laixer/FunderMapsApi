/**
 * The note the commit path writes when a reviewer commits a dossier that was
 * never closed by hand (routes/dataops-commit.ts). It names an internal
 * inquiry id and is for staff; the melder gets the plain explanation instead.
 */
const AUTO_COMMIT_NOTE = /^Overgenomen als rapportage #\d+$/;

export function isAutoCommitNote(note: string | null): boolean {
  return note !== null && AUTO_COMMIT_NOTE.test(note.trim());
}

/**
 * What the melder is told about a dossier, and what we actually record.
 *
 * Shared by the status page (`POST /api/intake/status`) and the closure mail
 * (`lib/intake-emails.ts`), so the two never disagree about what "verwerkt"
 * means.
 *
 * A dossier with no outcome yet is "ontvangen" or "in behandeling" depending on
 * whether anything has been committed. `duplicate` is deliberately not surfaced
 * as a rejection: a delivery we already hold is not a fault of the person who
 * sent it, and telling them otherwise would discourage exactly the behaviour we
 * want.
 */
export function describeOutcome(
  outcome: string | null,
  rawNote: string | null,
  hasInquiry: boolean,
): { state: string; explanation: string } {
  const note = rawNote && !isAutoCommitNote(rawNote) ? rawNote : null;
  switch (outcome) {
    case "accepted":
      return {
        state: "verwerkt",
        explanation:
          note ??
          "Uw melding is verwerkt. De gegevens van dit pand zijn bijgewerkt.",
      };
    case "duplicate":
      return {
        state: "verwerkt",
        explanation:
          note ??
          "Wij hebben uw melding bekeken. Deze gegevens waren al bij ons bekend, dus er is niets gewijzigd.",
      };
    case "no_data":
      return {
        state: "verwerkt",
        explanation:
          note ??
          "Wij hebben uw melding bekeken. Het meegestuurde materiaal bevatte geen gegevens over de fundering, dus er is niets gewijzigd.",
      };
    case "rejected":
      return {
        state: "afgewezen",
        explanation:
          note ??
          "Wij konden uw melding niet verwerken. Neem contact met ons op als u denkt dat dit niet klopt.",
      };
    default:
      return hasInquiry
        ? {
            state: "in behandeling",
            explanation: "Een beoordelaar is met uw melding bezig.",
          }
        : {
            state: "ontvangen",
            explanation:
              "Uw melding staat in de wachtrij. Een beoordelaar bekijkt hem zo snel mogelijk.",
          };
  }
}
