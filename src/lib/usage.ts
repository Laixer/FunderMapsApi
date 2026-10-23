/**
 * Usage for the Admin (GET /api/management/usage, 2026-10-23): Grafana's two
 * usage boards ("Usage - webservice & API", "Usage - maps & studio") moving
 * into the Admin. The pure part.
 *
 * The product tracker is the billing record. Which product is billable is the
 * boards' rule: a webservice product ends in its API version (analysis3,
 * facade_scan4); a product without one (analysis, statistics) is a lookup by
 * the map application or the Studio.
 */

export type UsageKind = "webservice" | "maps";

export const usageKind = (product: string): UsageKind => (/[34]$/.test(product) ? "webservice" : "maps");

export interface OrgWindowRow {
  id: string;
  name: string | null;
  product: string;
  month_to_date: number | string | null;
  last_month: number | string | null;
  last_30_days: number | string | null;
  previous_30_days: number | string | null;
}

export interface OrgUsage {
  id: string;
  name: string;
  month_to_date: number;
  last_month: number;
  last_30_days: number;
  previous_30_days: number;
  /** Last 30 days per product, largest first. */
  products: { product: string; last_30_days: number }[];
}

const n = (v: number | string | null) => Number(v ?? 0);

/** One row per organization for one kind of product, largest first by the last 30 days; quiet ones left out. */
export function foldOrganizations(rows: OrgWindowRow[], kind: UsageKind): OrgUsage[] {
  const by = new Map<string, OrgUsage>();
  for (const r of rows) {
    if (usageKind(r.product) !== kind) continue;
    const o = by.get(r.id) ?? { id: r.id, name: r.name ?? "(naamloos)", month_to_date: 0, last_month: 0, last_30_days: 0, previous_30_days: 0, products: [] };
    o.month_to_date += n(r.month_to_date);
    o.last_month += n(r.last_month);
    o.last_30_days += n(r.last_30_days);
    o.previous_30_days += n(r.previous_30_days);
    if (n(r.last_30_days) > 0) o.products.push({ product: r.product, last_30_days: n(r.last_30_days) });
    by.set(r.id, o);
  }
  return [...by.values()]
    .filter((o) => o.month_to_date + o.last_month + o.last_30_days + o.previous_30_days > 0)
    .map((o) => ({ ...o, products: o.products.sort((a, b) => b.last_30_days - a.last_30_days) }))
    .sort((a, b) => b.last_30_days - a.last_30_days || b.month_to_date - a.month_to_date || a.name.localeCompare(b.name));
}

/** Per product of one kind, its calls along `months`, largest product first by its total. */
export function productMonths(months: string[], rows: { product: string; month: string; calls: number | string }[], kind: UsageKind) {
  const by = new Map<string, number[]>();
  const index = new Map(months.map((m, i) => [m, i]));
  for (const r of rows) {
    if (usageKind(r.product) !== kind) continue;
    const i = index.get(r.month);
    if (i === undefined) continue;
    const series = by.get(r.product) ?? months.map(() => 0);
    series[i] = (series[i] ?? 0) + n(r.calls);
    by.set(r.product, series);
  }
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return [...by.entries()].map(([product, calls]) => ({ product, calls })).sort((a, b) => sum(b.calls) - sum(a.calls) || a.product.localeCompare(b.product));
}
