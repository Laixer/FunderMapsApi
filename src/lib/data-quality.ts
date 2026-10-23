/**
 * Datakwaliteit (GET /dataops/data-quality, 2026-10-23): what is in FunderMaps,
 * how it got there and how complete it is — the Grafana board "Data quality"
 * moving into the Studio. The pure part.
 *
 * Two dates, kept apart on purpose. `create_date` is when a row came into the
 * database, and single days carry whole imports (2021-09-24: 96,245 samples),
 * so per month it says how FunderMaps was filled, never how much work was done.
 * `document_date` is the date of the report itself, back to 1367 for archive
 * research.
 */

/** "2019-01" … "2026-10": every month from `from` to `to` inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

/** Values along `keys`, zero where a key had no row; bigint strings become numbers. */
export function along(keys: string[], rows: { key: string; value: number | string }[]): number[] {
  const by = new Map(rows.map((r) => [r.key, Number(r.value)]));
  return keys.map((k) => by.get(k) ?? 0);
}

/**
 * The QuickScan (facade_scan) fields the board counts as "complete" when all
 * are filled: the risk, the two assessments and the two measurements of the
 * leaning, the front facade's crack.
 */
export const QUICKSCAN_REQUIRED = [
  "facade_scan_risk",
  "skewed_parallel_facade",
  "skewed_perpendicular_facade",
  "skewed_parallel",
  "skewed_perpendicular",
  "crack_facade_front_type",
] as const;

/** The foundation-research fields the board measures, in its order. */
export const FOUNDATION_FIELDS = [
  "foundation_type", "overall_quality", "wood_quality", "construction_quality", "wood_capacity_horizontal_quality",
  "pile_wood_capacity_vertical_quality", "carrying_capacity_quality", "mason_quality", "wood_quality_necessity",
  "construction_level", "wood_level", "pile_diameter_top", "pile_head_level", "mason_level", "concrete_charger_length",
  "wood_penetration_depth", "enforcement_term", "recovery_advised", "damage_cause", "damage_characteristics",
  "construction_pile", "wood_type", "wood_encroachment", "threshold_updown_skewed", "threshold_front_level",
  "threshold_back_level", "skewed_parallel", "skewed_perpendicular", "skewed_parallel_facade", "settlement_speed",
  "skewed_window_frame", "skewed_perpendicular_facade", "note",
] as const;

/** snake_case column → the camelCase key the Studio's field registry uses. */
export const camel = (col: string) => col.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
