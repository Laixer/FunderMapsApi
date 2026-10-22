/**
 * The Studio's day (GET /dataops/today, 2026-10-22): what came in, what the
 * reader read, what people judged and what went into FunderMaps — today, and
 * per day for the last two weeks. The pure part: days without a row are days
 * with nothing, not missing days.
 */

export const METRICS = ["received", "read", "judged", "committed", "closed"] as const;
export type Metric = (typeof METRICS)[number];

export interface DayRow {
  day: string;
  metric: string;
  n: number;
}

/** One series per metric over `days` (oldest first), zero where nothing happened. */
export function dailySeries(days: string[], rows: DayRow[]): Record<Metric, number[]> {
  const index = new Map(days.map((d, i) => [d, i]));
  const out = Object.fromEntries(METRICS.map((m) => [m, days.map(() => 0)])) as Record<Metric, number[]>;
  for (const r of rows) {
    const i = index.get(r.day);
    if (i === undefined || !(METRICS as readonly string[]).includes(r.metric)) continue;
    out[r.metric as Metric][i] = (out[r.metric as Metric][i] ?? 0) + Number(r.n);
  }
  return out;
}

/** The median of a list of seconds, or null for none. */
export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}
