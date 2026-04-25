// Phase 1 backfill: compute SHA-256(key) for every auth_key row whose
// key_hash is still NULL and write it back. Idempotent — safe to re-run.
// The DB never hashes anything; we keep the SHA-256 computation in the
// app layer so we don't need pgcrypto (or any other extension).
//
// Usage:
//   DATABASE_URL=postgres://… bun run scripts/backfill_auth_key_hash.ts
//
// Connect as `fundermaps` (owner) or any role with SELECT+UPDATE on
// application.auth_key. Default DATABASE_URL in dev is sufficient.
//
// Verification queries are printed at the end — run them yourself to
// confirm before moving to Phase 2.

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { ssl: "prefer" });

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function main() {
  const rows = await sql<{ key: string }[]>`
    SELECT key
    FROM application.auth_key
    WHERE key_hash IS NULL
  `;

  console.log(`Found ${rows.length} rows needing backfill`);

  let updated = 0;
  for (const row of rows) {
    const hash = await sha256Hex(row.key);
    const result = await sql`
      UPDATE application.auth_key
      SET key_hash = ${hash}
      WHERE key = ${row.key}
        AND key_hash IS NULL
    `;
    updated += result.count;
  }

  console.log(`Updated ${updated} rows`);

  const [stats] = await sql<
    {
      total: number;
      hashed: number;
      missing: number;
      duplicates: number;
    }[]
  >`
    SELECT
      count(*)::int                                  AS total,
      count(key_hash)::int                           AS hashed,
      count(*) FILTER (WHERE key_hash IS NULL)::int  AS missing,
      (
        SELECT count(*)::int FROM (
          SELECT key_hash FROM application.auth_key
          WHERE key_hash IS NOT NULL
          GROUP BY key_hash HAVING count(*) > 1
        ) d
      ) AS duplicates
    FROM application.auth_key
  `;

  console.log("Final state:");
  console.log(`  total rows:        ${stats?.total}`);
  console.log(`  hashed:            ${stats?.hashed}`);
  console.log(`  still NULL:        ${stats?.missing}`);
  console.log(`  duplicate hashes:  ${stats?.duplicates}`);

  if (stats?.missing !== 0) {
    console.error("\nERROR: rows still NULL — backfill incomplete");
    process.exit(2);
  }
  if (stats?.duplicates !== 0) {
    console.error("\nERROR: duplicate hashes detected — investigate");
    process.exit(3);
  }

  console.log("\nBackfill OK.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
