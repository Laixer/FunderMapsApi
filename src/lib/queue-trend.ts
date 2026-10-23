/**
 * A slice of the queue over time (GET /dataops/queue/trend, 2026-10-23): the
 * Grafana board "Operations" ("Werkpakketten nu", "Open per pakket",
 * "Afgehandeld per pakket per dag") moving into the Studio's Vandaag. The pure
 * part: which filters a trend may take.
 *
 * A trend asks "how many were open at the end of each of the last 30 days".
 * A filter on a dossier's own facts (channel, document kind, subject text, the
 * pand, the municipality) holds for every one of those days. A filter on how a
 * dossier stands now (state, age, who holds it, its outcome, the scope) does
 * not: applied to a past day it would draw today's answer into last month.
 * Those are refused, not quietly ignored.
 */
export const NOW_ONLY_FILTERS = ["state", "age", "assignedTo", "outcome", "scope"] as const;

/** The query parameters that describe now, by name; empty when the trend may be drawn. */
export function nowOnlyFilters(query: Record<string, string | undefined>): string[] {
  return NOW_ONLY_FILTERS.filter((k) => (query[k] ?? "").trim() !== "");
}

export const TREND_DAYS = 30;
