import { type SQL, sql } from "drizzle-orm";
import { db } from "../../db/client.ts";

// The data of the PDF report, read with the SQL of the API's five report calls (building-info, analysis,
// statistics, report, subsidence/historic) in two queries, one per half of the report. Both are SELECT only:
// the billing rows the /product routes write are written once, by routes/pdf.ts.

export interface ReportData {
  pand: string;
  front: Record<string, unknown> & { missing?: string[] };
  back: Record<string, unknown>;
}

const sqlText = new Map<string, string>();
async function load(name: "front" | "back"): Promise<string> {
  let text = sqlText.get(name);
  if (!text) {
    text = await Bun.file(new URL(`./sql/${name}.sql`, import.meta.url)).text();
    sqlText.set(name, text);
  }
  return text;
}

// Every '__PAND__' in the SQL becomes a bound parameter. Full-line comments go first, so a placeholder named in
// a comment never becomes a parameter.
export function bindPand(text: string, pand: string): SQL {
  const code = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const parts = code.split("'__PAND__'");
  const chunks: SQL[] = [sql.raw(parts[0]!)];
  for (const part of parts.slice(1)) chunks.push(sql`${pand}`, sql.raw(part));
  return sql.join(chunks, sql.raw(""));
}

async function one(name: "front" | "back", pand: string): Promise<Record<string, unknown>> {
  const rows = (await db.execute(bindPand(await load(name), pand))) as unknown as Record<string, unknown>[];
  const value = rows[0] ? Object.values(rows[0])[0] : null;
  return (value ?? {}) as Record<string, unknown>;
}

export async function loadReportData(pand: string): Promise<ReportData> {
  const [front, back] = await Promise.all([one("front", pand), one("back", pand)]);
  return { pand, front, back };
}
