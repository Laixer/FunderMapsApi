/**
 * Which date a rapportage gets when the review lane commits a dossier (#338,
 * Don's rule 2026-09-14).
 *
 * report.inquiry.document_date is NOT NULL, so something has to be chosen.
 * The old fallback was the day the melding arrived -- for a 1911 archive
 * drawing filed in April 2026 that is the one date that is certainly wrong.
 *
 *   explicit (the reviewer typed it)      > what the reviewer took over from
 *   the document                          > for an archive drawing: the pand's
 *   construction year, flagged as an estimate > nothing: the reviewer must
 *   fill it in, the commit refuses.
 */

/** Document kinds whose date, when unreadable, is best approximated by the construction year. */
export const ARCHIVE_TYPES = new Set(["archive_research", "architectural_research"]);

export type DocumentDateSource = "explicit" | "document" | "built_year";

export interface DocumentDateChoice {
  date: string;
  source: DocumentDateSource;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** How far past today a document date may lie before it can only be a typo. */
export const MAX_YEARS_AHEAD = 10;

/**
 * Why a document date cannot be right, as a sentence for the person who typed
 * it, or null when it can.
 *
 * Only the impossible is refused: a date more than ten years from now. On
 * 2026-09-23 a rapportage was saved as 2926-05-15 (a slip for 2026) and has
 * headed the Studio's list, sorted by date, ever since. A date a little past
 * today is NOT refused: the QuickScan feed delivers reports dated days or weeks
 * after the delivery (52 rows on 2026-10-12), and those are real.
 *
 * A value that is not a date at all is left to the caller's own format check;
 * this only speaks when it can read the year.
 */
export function documentDateProblem(value: string | null | undefined, today: Date = new Date()): string | null {
  if (!value) return null;
  const year = Number(/^(\d{4})-\d{2}-\d{2}/.exec(value)?.[1]);
  if (!Number.isInteger(year)) return null;
  if (year > today.getUTCFullYear() + MAX_YEARS_AHEAD) {
    return `De documentdatum ${value.slice(0, 10)} ligt meer dan ${MAX_YEARS_AHEAD} jaar in de toekomst; klopt het jaar?`;
  }
  return null;
}

export function resolveDocumentDate(input: {
  explicit?: string | null;
  judged?: string | null;
  type: string;
  /** geocoder.building.built_year, as the driver returns it (YYYY-MM-DD or null). */
  builtYear?: string | null;
}): DocumentDateChoice | null {
  if (input.explicit && ISO_DAY.test(input.explicit)) return { date: input.explicit, source: "explicit" };
  if (input.judged && ISO_DAY.test(input.judged)) return { date: input.judged, source: "document" };
  if (ARCHIVE_TYPES.has(input.type) && input.builtYear) {
    const year = input.builtYear.slice(0, 4);
    if (/^\d{4}$/.test(year) && year !== "0000") return { date: `${year}-01-01`, source: "built_year" };
  }
  return null;
}
