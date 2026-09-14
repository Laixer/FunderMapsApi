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
