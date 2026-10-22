import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { summarise, type ReaderRow } from "../lib/reader-quality.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * The document reader's track record (lib/reader-quality.ts), for the Data
 * Studio: a hint beside every proposed value on the dossier page, and an
 * overview on the Datastroom page. Read-only, one grouped query (~20 ms over
 * the 8,833 judged values of 2026-10-22). Staff-only like the rest of
 * /api/dataops (authMiddleware + staffMiddleware, index.ts).
 */
const routes = new Hono<AppEnv>();

routes.get("/reader-quality", async (c) => {
  const rows = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (v.extraction_field_id) v.extraction_field_id, v.outcome
      FROM dataops.verdict v
      ORDER BY v.extraction_field_id, v.decided_at DESC, v.id DESC
    )
    SELECT f.field, e.model, e.prompt_version AS "promptVersion",
      count(*) FILTER (WHERE l.outcome = 'confirmed')::int AS confirmed,
      count(*) FILTER (WHERE l.outcome = 'corrected')::int AS corrected,
      count(*) FILTER (WHERE l.outcome = 'rejected')::int AS rejected
    FROM latest l
    JOIN dataops.extraction_field f ON f.id = l.extraction_field_id
    JOIN dataops.extraction e ON e.id = f.extraction_id
    WHERE e.prompt_version <> 'manual'
    GROUP BY 1, 2, 3
  `);
  return c.json({ generatedAt: new Date().toISOString(), ...summarise(rows as unknown as ReaderRow[]) });
});

export default routes;
