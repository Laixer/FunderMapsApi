import type { PgTable } from "drizzle-orm/pg-core";

/**
 * Values that do not fit their numeric(p, s) column, as readable messages.
 *
 * Postgres rejects such a value with "numeric field overflow" (22003) without
 * naming the column, so a commit failed with a bare 500 (Worker #223: dossier
 * 5599, lintvoegmeting 1 : 1117 in skewed_parallel, numeric(5,2)). Checking
 * against the Drizzle column's own precision and scale lets the caller answer
 * 422 with the field and its limit instead. Keys that are not a numeric column
 * of the table, and null values, are skipped.
 */
export function numericOverflows(table: PgTable, values: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const col = (table as unknown as Record<string, { precision?: number; scale?: number; name?: string } | undefined>)[key];
    if (!col || typeof col.precision !== "number") continue;
    const scale = col.scale ?? 0;
    const max = 10 ** (col.precision - scale) - 10 ** -scale;
    if (Math.abs(value) > max) {
      out.push(`${col.name ?? key}: ${value} past niet in het veld (maximaal ${max.toFixed(scale)})`);
    }
  }
  return out;
}
