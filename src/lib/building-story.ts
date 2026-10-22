/**
 * One pand's story for the Studio's Pand page (GET /dataops/building/:id).
 * The pure part: which model recalculations moved this pand, and what they
 * moved. A recalculation entry ("Funderingsrisico herberekend…") lists its
 * changes per pand: `{ address, buildingId, fields: [{ label, before, after,
 * beforeLabel?, afterLabel? }] }`; the labels are the letters the map shows.
 */

export interface RecalcRow {
  dossierId: number;
  at: string;
  body: Record<string, unknown> | null;
}

export interface ModelChange {
  at: string;
  dossierId: number;
  address: string | null;
  fields: { label: string; before: string | null; after: string | null }[];
}

const same = (a: unknown, b: string) => typeof a === "string" && a.toUpperCase() === b.toUpperCase();
const shown = (label: unknown, raw: unknown) => (label != null ? String(label) : raw != null ? String(raw) : null);

/** The changes that name this pand, newest first; a recalculation that moved nothing here is left out. */
export function modelChangesFor(rows: RecalcRow[], buildingId: string): ModelChange[] {
  const out: ModelChange[] = [];
  for (const r of rows) {
    const changes = Array.isArray(r.body?.changes) ? (r.body!.changes as Record<string, unknown>[]) : [];
    for (const c of changes) {
      if (!same(c.buildingId, buildingId)) continue;
      const fields = (Array.isArray(c.fields) ? (c.fields as Record<string, unknown>[]) : [])
        .map((f) => ({ label: String(f.label ?? ""), before: shown(f.beforeLabel, f.before), after: shown(f.afterLabel, f.after) }))
        .filter((f) => f.label && f.before !== f.after);
      if (fields.length) out.push({ at: r.at, dossierId: r.dossierId, address: typeof c.address === "string" ? c.address : null, fields });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
