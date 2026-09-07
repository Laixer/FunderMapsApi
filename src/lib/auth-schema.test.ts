import { describe, test, expect } from "bun:test";

// Guard against Better Auth schema drift. Better Auth (and its plugins) declare
// the columns they expect per model; the Drizzle adapter throws at *runtime*
// — inside a token exchange — when it is handed a field the Drizzle schema
// doesn't know. 1.6.25 → 1.7.1 added ~25 OAuth-provider columns that way and
// took every OIDC login down for 3 hours on 2026-08-23 with a green CI.
// This test fails the build instead.
//
// config.ts parses process.env at import time and the OAuth provider plugin
// needs a parseable base URL to initialise; none of this opens a connection.
process.env.DATABASE_URL ??= "postgres://test@localhost:5432/test";
process.env.APP_ID ??= "ci-test-app";
process.env.AUTH_SECRET ??= "ci-test-secret-not-used-for-anything-real";
process.env.BASE_URL ??= "http://localhost:3000";

const { getAuthTables } = await import("better-auth/db");
const { diffSchema, getExpectedSchema } = await import(
  "@better-auth/core/db/internal"
);
const { getTableColumns, getTableName, is } = await import("drizzle-orm");
const { PgTable } = await import("drizzle-orm/pg-core");
const { Table } = await import("drizzle-orm");
const { auth } = await import("./auth");
const schema = await import("../db/schema");

// Fields Better Auth declares that we deliberately do not carry. Add to this
// list only with a reason; every other gap is a bug.
const ACCEPTED_GAPS: Record<string, string[]> = {
  // No avatar support; Better Auth treats it as optional and never writes it
  // from the email/password flow.
  user: ["image"],
};

const drizzleTables: Record<string, unknown> = {};
for (const [name, value] of Object.entries(schema)) {
  if (is(value, PgTable)) drizzleTables[name] = value;
}

const models = getAuthTables(auth.options);

describe("Better Auth ↔ Drizzle schema", () => {
  for (const [model, def] of Object.entries(models)) {
    const modelName = def.modelName ?? model;
    test(`model "${model}" (${modelName}) has every field in the Drizzle schema`, () => {
      const table = drizzleTables[modelName] ?? drizzleTables[model];
      expect(
        table,
        `Better Auth expects a "${modelName}" table but src/db/schema exports none — a plugin upgrade added a model; add the table and a migration`,
      ).toBeDefined();
      const have = new Set(Object.keys(getTableColumns(table as never)));
      const missing = Object.keys(def.fields).filter(
        (f) => !have.has(f) && !(ACCEPTED_GAPS[model] ?? []).includes(f),
      );
      expect(
        missing,
        `application.${getTableName(table as never)} is missing columns Better Auth will write: ${missing.join(", ")} — add them to the Drizzle schema AND ship the DDL (FunderMapsWorker sql/migrate) before deploying`,
      ).toEqual([]);
    });
  }
});

// Since 1.7.3 the Drizzle adapter runs this exact comparison on first use and
// rejects every auth request while it reports a finding (SCHEMA_MISMATCH).
// Two things trip it that the field-presence test above cannot see:
//   - a column in a BA table that is NOT NULL without a default and that BA
//     never writes (account.issuer after 1.7.3 dropped the issuer key);
//   - an additionalField whose `fieldName` does not match the Drizzle
//     property (BA indexes the Drizzle table by fieldName, not by column).
// Mirror the adapter's introspection so the build fails, not the login.
describe("Better Auth 1.7.3 init-time schema check", () => {
  test("the adapter finds nothing to complain about", () => {
    const tables = [];
    for (const [name, table] of Object.entries(schema)) {
      if (!is(table, Table)) continue;
      tables.push({
        name,
        columns: Object.entries(getTableColumns(table as never)).map(
          ([key, column]) => {
            const c = column as {
              notNull: boolean;
              hasDefault: boolean;
              generated?: unknown;
              generatedIdentity?: unknown;
            };
            return {
              name: key,
              nullable: !c.notNull,
              hasDefault:
                c.hasDefault ||
                c.generated !== undefined ||
                c.generatedIdentity !== undefined,
            };
          },
        ),
      });
    }
    const findings = diffSchema(getExpectedSchema(auth.options), tables);
    expect(
      findings,
      `Better Auth would refuse to start on this schema:\n${JSON.stringify(findings, null, 2)}`,
    ).toEqual([]);
  });
});
