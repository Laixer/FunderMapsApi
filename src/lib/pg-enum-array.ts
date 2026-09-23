import { sql, type SQL } from "drizzle-orm";

/**
 * Postgres enum arrays (API #128, report.inquiry_sample.damage_cause_list).
 * postgres.js has no parser for a custom enum's array type, so a read comes
 * back as the literal "{drystand,drainage}"; a write has to name the type,
 * because text[] does not cast to an enum array on assignment.
 */
export function parseEnumArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  const inner = value.trim().replace(/^\{|\}$/g, "");
  if (!inner) return [];
  // Enum labels are plain identifiers: no commas, quotes or braces to escape.
  return inner.split(",").map((v) => v.replace(/^"|"$/g, "").trim()).filter(Boolean);
}

/** A typed enum-array value for an insert or update: `'{a,b}'::<type>[]`. */
export function enumArray(values: string[], pgType: "report.foundation_damage_cause" | "report.foundation_damage_characteristics"): SQL {
  const literal = `{${values.join(",")}}`;
  return sql`${literal}::${sql.raw(pgType)}[]`;
}
