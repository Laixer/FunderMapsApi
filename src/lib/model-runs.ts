/**
 * The model's runs and the spread of its labels, for the Data Studio's
 * "Modellen" page (2026-10-22).
 *
 * Runs: the refresh log, as two slots a day (the 12:30 and the 21:00
 * refresh, Amsterdam time), each ok, failed or missing; plus what the last
 * exports took. Spread: how many buildings the served model (the default,
 * `data.model_risk_static`) puts in each foundation type and in each class of
 * the four risks. The spread scans ~11 million rows (~3 s), so the route keeps
 * it until the next refresh has run.
 */

export type Slot = "midday" | "evening";

export interface RunRow {
  day: string;
  hour: number;
  status: string;
  finishedAt: string;
}

/** The refresh before 17:00 is the midday one (12:30); after, the evening one (21:00). */
export const slotOf = (hour: number): Slot => (hour < 17 ? "midday" : "evening");

/**
 * Every day × slot, newest day first: the run's status and when it finished,
 * or `missing` when none finished in that slot. A slot later today that has
 * not come yet is `upcoming`, not missing.
 */
export function runGrid(days: string[], runs: RunRow[], now: { day: string; hour: number }) {
  return [...days].reverse().map((day) => {
    const slot = (s: Slot) => {
      const run = runs.filter((r) => r.day === day && slotOf(r.hour) === s).at(-1);
      if (run) return { status: run.status === "ok" ? "ok" : "failed", finishedAt: run.finishedAt };
      const due = s === "midday" ? 14 : 23;
      return { status: day === now.day && now.hour < due ? "upcoming" : "missing", finishedAt: null };
    };
    return { day, midday: slot("midday"), evening: slot("evening") };
  });
}

export interface ClassRow {
  risk: string;
  klass: string | null;
  n: number;
}

/** Per risk: buildings per class a–e and without a class, in that order. */
export function riskSpread(rows: ClassRow[]) {
  const out: Record<string, { a: number; b: number; c: number; d: number; e: number; none: number }> = {};
  for (const r of rows) {
    const t = (out[r.risk] ??= { a: 0, b: 0, c: 0, d: 0, e: 0, none: 0 });
    const k = (r.klass ?? "").toLowerCase();
    if (k === "a" || k === "b" || k === "c" || k === "d" || k === "e") t[k] += r.n;
    else t.none += r.n;
  }
  return out;
}
