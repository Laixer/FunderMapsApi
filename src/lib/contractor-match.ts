/**
 * Which application.contractor a bureau's name on a report cover refers to.
 *
 * The pipeline reads the name as printed ("Fugro GeoServices B.V.", "Wareco
 * Ingenieurs"); the table holds it as someone once typed it ("Fugro",
 * "Wareco"). The two agree on the distinctive part and disagree on legal
 * suffixes, punctuation and how much of the letterhead was copied, so the
 * match is on a normalised form, exact first and then by prefix. Nothing is
 * ever created here: "Techniek en Methode" and "Techniek & Methode" already
 * both exist, and a model reading letterheads would add a third.
 */

export interface ContractorRow {
  id: number;
  name: string;
}

const LEGAL_SUFFIXES = /\b(b\.?\s?v\.?|n\.?\s?v\.?|v\.?o\.?f\.?|c\.?v\.?|bv|nv|vof|holding|groep|group)\b/g;

/** Lower-case, no punctuation, no legal form, single spaces. */
export function normaliseContractorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " en ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The best match, or null. Exact normalised name wins; otherwise the longest
 * row whose name is a word-prefix of the printed one, or vice versa, provided
 * the shared part is at least 4 characters -- "IMG" would otherwise claim
 * every "Imgenieursbureau" typo and "BVL" every bureau starting with a B.
 */
export function matchContractor(printed: string, rows: ContractorRow[]): ContractorRow | null {
  const p = normaliseContractorName(printed);
  if (p.length < 2) return null;
  const candidates = rows.map((r) => ({ row: r, n: normaliseContractorName(r.name) })).filter((c) => c.n.length > 0);
  const exact = candidates.find((c) => c.n === p);
  if (exact) return exact.row;
  const prefix = (long: string, short: string) => short.length >= 4 && (long === short || long.startsWith(`${short} `));
  const partial = candidates
    .filter((c) => prefix(p, c.n) || prefix(c.n, p))
    .sort((a, b) => b.n.length - a.n.length);
  return partial[0]?.row ?? null;
}
