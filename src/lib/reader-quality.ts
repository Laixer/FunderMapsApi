/**
 * The document reader's track record: per field, how often a reviewer took
 * over the value it proposed, corrected it, or rejected it.
 *
 * Counted on the latest verdict per proposed value (a value reopened and
 * decided again counts once, as it ended). Values a reviewer typed in
 * themselves (`prompt_version = 'manual'`) are not the reader's work and are
 * left out by the query. "Overgenomen" includes ranges taken over in one
 * click (API #199): it says a person let the value stand, not that it was
 * checked one by one.
 */

export interface Tally {
  judged: number;
  confirmed: number;
  corrected: number;
  rejected: number;
}

export interface ReaderRow {
  field: string;
  model: string;
  promptVersion: string;
  confirmed: number;
  corrected: number;
  rejected: number;
}

const empty = (): Tally => ({ judged: 0, confirmed: 0, corrected: 0, rejected: 0 });

function add(t: Tally, r: Pick<ReaderRow, "confirmed" | "corrected" | "rejected">) {
  t.confirmed += r.confirmed;
  t.corrected += r.corrected;
  t.rejected += r.rejected;
  t.judged += r.confirmed + r.corrected + r.rejected;
}

/** The share a reviewer did not take over as read: corrected or rejected. */
export const missRate = (t: Tally) => (t.judged > 0 ? (t.corrected + t.rejected) / t.judged : 0);

/**
 * Rows per field × model × prompt version, summed three ways: overall, per
 * field (most judged first) and per reader version (in the order the
 * versions sort, which is the order they were introduced: dataops-2026.1,
 * dataops-2026.2, ...).
 */
export function summarise(rows: ReaderRow[]) {
  const total = empty();
  const fields = new Map<string, Tally>();
  const versions = new Map<string, Tally & { model: string; promptVersion: string }>();
  for (const r of rows) {
    add(total, r);
    const f = fields.get(r.field) ?? empty();
    add(f, r);
    fields.set(r.field, f);
    const key = `${r.model}\u0000${r.promptVersion}`;
    const v = versions.get(key) ?? { ...empty(), model: r.model, promptVersion: r.promptVersion };
    add(v, r);
    versions.set(key, v);
  }
  return {
    total,
    fields: [...fields.entries()]
      .map(([field, t]) => ({ field, ...t }))
      .sort((a, b) => b.judged - a.judged || a.field.localeCompare(b.field)),
    versions: [...versions.values()].sort((a, b) => a.promptVersion.localeCompare(b.promptVersion) || a.model.localeCompare(b.model)),
  };
}
