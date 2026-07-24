/**
 * Regenerates src/lib/enum-contract.snapshot.json.
 *
 * The bimaps in src/lib/inquiry-enums.ts straddle two upstream sources of
 * truth that live outside this repo:
 *
 *   - the integer  comes from the C# enum member value (the JSON wire format
 *     is whatever System.Text.Json produced), in FunderMaps.Core/Types/*.cs
 *   - the string   comes from the PG enum label
 *
 * CI has neither a database nor the C# repo, so we freeze both into a
 * checked-in snapshot and let the contract test diff the bimaps against it.
 * Run this whenever a PG enum or a C# enum changes; a drifting bimap then
 * shows up as a failing test rather than as silently mismapped data.
 *
 *   DATABASE_URL=postgres://... \
 *   CSHARP_REPO=~/src/FunderMaps \
 *     bun run scripts/refresh-enum-snapshot.ts
 *
 * Deliberately does not import src/db/client.ts: that pulls in config.ts,
 * which demands the full service env (APP_ID, AUTH_SECRET, ...) that this
 * script has no use for.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";

import { ENUM_NAMES } from "../src/lib/inquiry-enums.ts";

const SNAPSHOT_PATH = resolve(
  import.meta.dirname,
  "../src/lib/enum-contract.snapshot.json",
);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const csharpRepo = (process.env.CSHARP_REPO ?? "~/src/FunderMaps").replace(
  /^~/,
  process.env.HOME ?? "~",
);
const typesDir = join(csharpRepo, "src/FunderMaps.Core/Types");

/** snake_case bimap key → PascalCase C# type name. */
function pascalCase(snake: string): string {
  return snake
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * PascalCase C# member → snake_case PG label. Digits stay attached to the
 * word they trail (Area1 → area1, Term510 → term510), so only a letter
 * boundary introduces an underscore.
 */
function snakeCase(pascal: string): string {
  return pascal.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toLowerCase();
}

/** Parse `Member = 0,` pairs out of a C# enum file, ignoring comments. */
function parseCsharpEnum(typeName: string): Record<string, number> {
  const source = readFileSync(join(typesDir, `${typeName}.cs`), "utf8");
  const members: Record<string, number> = {};
  for (const line of source.split("\n")) {
    const stripped = line.replace(/\/\/.*$/, "").trim();
    const match = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(\d+)\s*,?$/.exec(stripped);
    if (match) members[match[1]!] = Number(match[2]);
  }
  if (Object.keys(members).length === 0) {
    throw new Error(`no enum members parsed out of ${typeName}.cs`);
  }
  return members;
}

const sql = postgres(databaseUrl);

const pgRows = await sql<{ schema: string; name: string; labels: string[] }[]>`
  SELECT n.nspname AS schema,
         t.typname AS name,
         array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typname::text = ANY(${[...ENUM_NAMES]}::text[])
  GROUP BY 1, 2
`;
await sql.end();

const pgByName = new Map(pgRows.map((r) => [r.name, r]));

type SnapshotEntry = {
  pgType: string;
  pgLabels: string[];
  csharpType: string;
  csharpMembers: Record<string, number>;
  /** (int, string) pairs the bimap must contain, sorted by int. */
  expectedPairs: [number, string][];
};

const enums: Record<string, SnapshotEntry> = {};
const problems: string[] = [];

for (const name of [...ENUM_NAMES].sort()) {
  const pg = pgByName.get(name);
  if (!pg) {
    problems.push(`${name}: no PG enum type with this name`);
    continue;
  }

  const csharpType = pascalCase(name);
  const csharpMembers = parseCsharpEnum(csharpType);

  // Pair each C# member with the PG label its name derives to. If the two
  // sides don't line up exactly, the derivation has hit a case it can't
  // express — fail loudly here rather than encode a wrong pairing.
  const pairs: [number, string][] = [];
  const derived = new Set<string>();
  for (const [member, value] of Object.entries(csharpMembers)) {
    const label = snakeCase(member);
    derived.add(label);
    pairs.push([value, label]);
  }

  const pgLabels = new Set(pg.labels);
  const missingInPg = [...derived].filter((l) => !pgLabels.has(l));
  const missingInCsharp = [...pgLabels].filter((l) => !derived.has(l));
  if (missingInPg.length || missingInCsharp.length) {
    problems.push(
      `${name}: C# and PG disagree` +
        (missingInPg.length ? `\n    only in C#: ${missingInPg.join(", ")}` : "") +
        (missingInCsharp.length
          ? `\n    only in PG: ${missingInCsharp.join(", ")}`
          : ""),
    );
    continue;
  }

  pairs.sort((a, b) => a[0] - b[0]);
  enums[name] = {
    pgType: `${pg.schema}.${pg.name}`,
    pgLabels: pg.labels,
    csharpType,
    csharpMembers,
    expectedPairs: pairs,
  };
}

if (problems.length) {
  console.error("Refusing to write snapshot:\n");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

// No timestamp: a snapshot that churns on every run makes its own diffs
// unreadable, which defeats the point of checking it in.
writeFileSync(SNAPSHOT_PATH, `${JSON.stringify({ enums }, null, 2)}\n`);
console.log(
  `Wrote ${Object.keys(enums).length} enums to ${SNAPSHOT_PATH.replace(process.env.HOME ?? "", "~")}`,
);
