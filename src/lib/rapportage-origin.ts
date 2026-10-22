import { personName } from "./person-name.ts";

/**
 * Where a rapportage came from, for the Data Studio's rapportage page: the
 * dossier(s) it was taken over from, their documents, how many values were
 * found and judged and by whom, who took it over when, and what the risk
 * recalculation after it changed. Plus the nalezingen that read it again.
 *
 * Built from rows the route reads (routes/dataops-origin.ts). Nothing about
 * the melder (name, e-mail) is read or returned: this is about the data.
 */

export interface PersonRow {
  givenName: string | null;
  lastName: string | null;
  name: string | null;
  email: string | null;
}

export interface EntryRow extends Partial<PersonRow> {
  dossierId: number;
  at: string;
  text: string;
  body: Record<string, unknown> | null;
}

export interface RiskChange {
  address: string | null;
  fields: { label: string; before: string | null; after: string | null }[];
}

const nameOf = (p: Partial<PersonRow> | undefined) =>
  p && p.email ? personName({ name: p.name, givenName: p.givenName, lastName: p.lastName, email: p.email }) : null;

/** The take-over entry is the one that names this rapportage: `inquiry_id`, or among `inquiry_ids`. */
export function namesInquiry(body: Record<string, unknown> | null, inquiryId: number): boolean {
  if (!body) return false;
  if (Number(body.inquiry_id) === inquiryId) return true;
  return Array.isArray(body.inquiry_ids) && body.inquiry_ids.map(Number).includes(inquiryId);
}

/**
 * The take-over of this rapportage in one dossier's log, and the risk
 * recalculations at or after it. A recalculation lists, per address, the risks
 * that moved; one that moved nothing says `unchanged`.
 */
export function commitAndRisk(entries: EntryRow[], inquiryId: number) {
  const commits = entries.filter((e) => e.text.startsWith("Overgenomen als rapportage") && namesInquiry(e.body, inquiryId));
  const commit = commits.at(-1) ?? null;
  const since = commit ? new Date(commit.at).getTime() : -Infinity;
  const recalcs = entries.filter((e) => e.text.startsWith("Funderingsrisico herberekend") && new Date(e.at).getTime() >= since);
  const changed: RiskChange[] = [];
  for (const r of recalcs) {
    const changes = Array.isArray(r.body?.changes) ? (r.body!.changes as Record<string, unknown>[]) : [];
    for (const c of changes) {
      const fields = Array.isArray(c.fields) ? (c.fields as Record<string, unknown>[]) : [];
      changed.push({
        address: typeof c.address === "string" ? c.address : null,
        fields: fields.map((f) => ({
          label: String(f.label ?? ""),
          before: f.before == null ? null : String(f.before),
          after: f.after == null ? null : String(f.after),
        })),
      });
    }
  }
  return {
    committed: commit ? { at: commit.at, by: nameOf(commit) } : null,
    risk: recalcs.length ? { changed, unchanged: changed.length === 0 } : null,
  };
}

/** Distinct names, in the order first seen; a person without an e-mail address is left out. */
export function people(rows: Partial<PersonRow>[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const n = nameOf(r);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}
