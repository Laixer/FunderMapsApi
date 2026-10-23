/**
 * The reader at work, per day (GET /dataops/reader-ops, 2026-10-23): the
 * Grafana board "Intake pipeline" moving into the Studio's Datastroom. The
 * pure part: day rows into series over a fixed span, zero (or null, for a
 * duration) where a day had nothing.
 */

export interface DayValue {
  day: string;
  key: string;
  value: number | string | null;
}

/** One series per key over `days` (oldest first); `empty` where a day has no row. */
export function seriesByKey<E extends number | null>(days: string[], rows: DayValue[], keys: readonly string[], empty: E): Record<string, (number | E)[]> {
  const index = new Map(days.map((d, i) => [d, i]));
  const out: Record<string, (number | E)[]> = Object.fromEntries(keys.map((k) => [k, days.map(() => empty)]));
  for (const r of rows) {
    const i = index.get(r.day);
    const series = out[r.key];
    if (i === undefined || !series || r.value == null) continue;
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    series[i] = (typeof series[i] === "number" ? (series[i] as number) : 0) + v;
  }
  return out;
}

/** A person's name for the effort table: their name, else the part of the e-mail before the @. */
export function personLabel(p: { name: string | null; givenName: string | null; lastName: string | null; email: string | null }): string {
  const full = [p.givenName, p.lastName].filter(Boolean).join(" ").trim();
  return full || p.name?.trim() || p.email?.split("@")[0] || "onbekend";
}
