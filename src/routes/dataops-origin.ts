import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.ts";
import { ValidationError } from "../lib/errors.ts";
import { commitAndRisk, people, type EntryRow, type PersonRow } from "../lib/rapportage-origin.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * GET /dataops/rapportage/:id/origin — where a rapportage came from
 * (lib/rapportage-origin.ts). A rapportage typed in by hand has no dossier:
 * both lists come back empty and the Studio says "met de hand ingevoerd".
 * Read-only, staff-only like the rest of /api/dataops.
 */
const routes = new Hono<AppEnv>();

const rows = <T>(r: unknown) => r as T[];
/** ISO 8601 (to_json), which every browser parses; the text form "…+00" is not reliably parsed. */
const iso = (col: SQL) => sql`to_json(${col}) #>> '{}'`;

routes.get("/rapportage/:id/origin", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError(["rapportage id must be a positive integer"]);

  const [dossiers, audits] = await Promise.all([
    db.execute(sql`
      SELECT d.id::int AS id, d.reference, d.channel::text AS channel, d.subject,
        ${iso(sql`d.received_at`)} AS "receivedAt", ${iso(sql`d.outcome_at`)} AS "outcomeAt"
      FROM dataops.dossier d
      WHERE (d.inquiry_id = ${id}
        OR EXISTS (SELECT 1 FROM dataops.dossier_rapportage r WHERE r.dossier_id = d.id AND r.inquiry_id = ${id}))
        -- A nalezing of this rapportage is listed under audits, also when its values went into it.
        AND d.audit_inquiry_id IS DISTINCT FROM ${id}
      ORDER BY d.received_at, d.id
    `),
    db.execute(sql`
      SELECT d.id::int AS id, ${iso(sql`d.received_at`)} AS "receivedAt", d.outcome::text AS outcome, ${iso(sql`d.outcome_at`)} AS "outcomeAt",
        (SELECT count(*)::int FROM dataops.extraction_field f JOIN dataops.extraction e ON e.id = f.extraction_id
           JOIN dataops.artifact a ON a.id = e.artifact_id
           WHERE a.dossier_id = d.id AND f.state IN ('pending', 'auto_accepted')) AS open,
        (SELECT count(*)::int FROM dataops.extraction_field f JOIN dataops.extraction e ON e.id = f.extraction_id
           JOIN dataops.artifact a ON a.id = e.artifact_id
           WHERE a.dossier_id = d.id AND f.state IN ('confirmed', 'corrected', 'rejected')) AS judged
      FROM dataops.dossier d
      WHERE d.audit_inquiry_id = ${id}
      ORDER BY d.received_at DESC, d.id DESC
    `),
  ]);

  type Dossier = { id: number; reference: string | null; channel: string; subject: string | null; receivedAt: string; outcomeAt: string | null };
  const list = rows<Dossier>(dossiers);
  const ids = list.map((d) => d.id);
  if (!ids.length) return c.json({ dossiers: [], audits: rows(audits) });

  const idArray = sql`ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::bigint[]`;
  const [documents, counts, deciders, entries] = await Promise.all([
    db.execute(sql`
      SELECT a.dossier_id::int AS "dossierId", a.id::int AS id, a.original_filename AS name,
        greatest(coalesce(a.page_count, 0), (SELECT count(*) FROM dataops.artifact_page p WHERE p.artifact_id = a.id))::int AS pages
      FROM dataops.artifact a WHERE a.dossier_id = ANY(${idArray}) ORDER BY a.id
    `),
    db.execute(sql`
      SELECT a.dossier_id::int AS "dossierId",
        count(*) FILTER (WHERE f.state <> 'superseded')::int AS found,
        count(*) FILTER (WHERE f.state IN ('confirmed', 'corrected', 'rejected'))::int AS judged
      FROM dataops.extraction_field f JOIN dataops.extraction e ON e.id = f.extraction_id
      JOIN dataops.artifact a ON a.id = e.artifact_id
      WHERE a.dossier_id = ANY(${idArray}) GROUP BY 1
    `),
    db.execute(sql`
      SELECT DISTINCT a.dossier_id::int AS "dossierId", u.given_name AS "givenName", u.last_name AS "lastName", u.name, u.email
      FROM dataops.verdict v
      JOIN dataops.extraction_field f ON f.id = v.extraction_field_id
      JOIN dataops.extraction e ON e.id = f.extraction_id
      JOIN dataops.artifact a ON a.id = e.artifact_id
      JOIN application."user" u ON u.id = v.decided_by
      WHERE a.dossier_id = ANY(${idArray})
    `),
    db.execute(sql`
      SELECT e.dossier_id::int AS "dossierId", ${iso(sql`e.at`)} AS at, e.text, e.body,
        u.given_name AS "givenName", u.last_name AS "lastName", u.name, u.email
      FROM dataops.dossier_entry e
      LEFT JOIN application."user" u ON u.id::text = e.actor
      WHERE e.dossier_id = ANY(${idArray}) AND e.kind = 'status'
        AND (e.text LIKE 'Overgenomen als rapportage%' OR e.text LIKE 'Funderingsrisico herberekend%')
      ORDER BY e.at, e.id
    `),
  ]);

  type Doc = { dossierId: number; id: number; name: string | null; pages: number };
  type Count = { dossierId: number; found: number; judged: number };
  const docs = rows<Doc>(documents);
  const tally = new Map(rows<Count>(counts).map((r) => [r.dossierId, r]));
  const who = rows<PersonRow & { dossierId: number }>(deciders);
  const log = rows<EntryRow>(entries);

  return c.json({
    dossiers: list.map((d) => ({
      ...d,
      documents: docs.filter((x) => x.dossierId === d.id).map(({ id, name, pages }) => ({ id, name, pages })),
      found: tally.get(d.id)?.found ?? 0,
      judged: tally.get(d.id)?.judged ?? 0,
      judgedBy: people(who.filter((p) => p.dossierId === d.id)),
      ...commitAndRisk(log.filter((e) => e.dossierId === d.id), id),
    })),
    audits: rows(audits),
  });
});

export default routes;
