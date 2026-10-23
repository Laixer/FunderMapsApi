/**
 * Terugmeldingen (GET /dataops/feedback, 2026-10-23): what owners and advisers
 * report back about a building's foundation information, the Grafana board
 * "Terugmeldingen" moving into the Studio. The pure part.
 */

export interface YearRow {
  year: string;
  portal: number | string;
  melden: number | string;
}

/** Every year from `from` to `to`, zero where a year had nothing; bigint strings become numbers. */
export function yearsFrom(from: number, to: number, rows: YearRow[]): { year: string; portal: number; melden: number }[] {
  const byYear = new Map(rows.map((r) => [r.year, r]));
  const out: { year: string; portal: number; melden: number }[] = [];
  for (let y = from; y <= to; y++) {
    const r = byYear.get(String(y));
    out.push({ year: String(y), portal: Number(r?.portal ?? 0), melden: Number(r?.melden ?? 0) });
  }
  return out;
}

/**
 * A subject as people read it: the per-dossier follow-up subjects ("Aanvullende
 * stukken bij FM2026-000663") are one subject, not one row per dossier.
 */
export function subjectGroup(subject: string | null): string {
  const s = subject?.trim();
  if (!s) return "(geen onderwerp)";
  if (/^Aanvullende stukken bij /i.test(s)) return "Aanvullende stukken";
  return s;
}

export interface SubjectRow {
  subject: string | null;
  received: number | string;
  handled: number | string;
  ledToReport: number | string;
}

/** Subjects folded by `subjectGroup`, largest first. */
export function foldSubjects(rows: SubjectRow[]): { subject: string; received: number; handled: number; ledToReport: number }[] {
  const out = new Map<string, { subject: string; received: number; handled: number; ledToReport: number }>();
  for (const r of rows) {
    const subject = subjectGroup(r.subject);
    const o = out.get(subject) ?? { subject, received: 0, handled: 0, ledToReport: 0 };
    o.received += Number(r.received);
    o.handled += Number(r.handled);
    o.ledToReport += Number(r.ledToReport);
    out.set(subject, o);
  }
  return [...out.values()].sort((a, b) => b.received - a.received || a.subject.localeCompare(b.subject));
}
