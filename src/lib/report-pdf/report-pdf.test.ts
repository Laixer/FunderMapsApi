import { afterEach, describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { bindPand } = await import("./data.ts");
const { borderLines, renderMap } = await import("./map.ts");
const { amsterdamDate } = await import("./render.ts");

const PAND = "NL.IMBAG.PAND.0363100012066783";
const toQuery = (q: ReturnType<typeof bindPand>) => new PgDialect().sqlToQuery(q);

describe("report data: the pand id is a bound parameter", () => {
  test("every '__PAND__' becomes a parameter; one named in a comment does not", () => {
    const q = toQuery(bindPand("-- '__PAND__' is the pand\nselect '__PAND__'::text as p where x = '__PAND__'", PAND));
    expect(q.sql).not.toContain("__PAND__");
    expect(q.sql).toContain("$1::text");
    expect(q.params).toEqual([PAND, PAND]);
  });

  test("the two report queries keep no placeholder and bind nothing but the pand", async () => {
    for (const name of ["front", "back"]) {
      const text = await Bun.file(new URL(`./sql/${name}.sql`, import.meta.url)).text();
      const q = toQuery(bindPand(text, PAND));
      expect(q.sql).not.toContain("__PAND__");
      expect(q.params.length).toBeGreaterThan(0);
      expect(new Set(q.params)).toEqual(new Set([PAND]));
    }
  });
});

describe("report data: only tables the API's database role may read", () => {
  test("no maplayer table (the Incidenten districts come from the tiles)", async () => {
    for (const name of ["front", "back"]) {
      const text = await Bun.file(new URL(`./sql/${name}.sql`, import.meta.url)).text();
      const code = text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
      expect(code).not.toMatch(/\bmaplayer\./);
    }
  });
});

describe("Incidenten districts: the border without the tiles' cut lines", () => {
  const P = (x: number, y: number) => ({ x, y });
  test("a polygon inside the tile keeps its whole ring as one line", () => {
    const ring = [P(10, 10), P(100, 10), P(100, 100), P(10, 100), P(10, 10)];
    expect(borderLines([ring], 4096)).toEqual([ring]);
  });

  test("the sides along the clip line past the tile edge are left out", () => {
    // a district running out of the tile on the right: ST_AsMVTGeom cut it at x = 4096 + 64
    const ring = [P(4000, 10), P(4160, 10), P(4160, 200), P(4000, 200), P(4000, 10)];
    expect(borderLines([ring], 4096)).toEqual([[P(4160, 200), P(4000, 200), P(4000, 10), P(4160, 10)]]);
  });

  test("a corner piece loses both cut sides and keeps its real border as one line", () => {
    const ring = [P(-64, -64), P(50, -64), P(50, 0), P(0, 50), P(-64, 50), P(-64, -64)];
    expect(borderLines([ring], 4096)).toEqual([[P(50, -64), P(50, 0), P(0, 50), P(-64, 50)]]);
  });
});

describe("report maps", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a view without tiles is the basemap's background and no street names", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (!url.includes("{z}") && !url.endsWith(".pbf")) {
        return Response.json({ tiles: ["https://tiles.test/{z}/{x}/{y}.pbf"], maxzoom: 14 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const m = await renderMap({ lon: 4.9095, lat: 52.3451, zoom: 16, width: 717, height: 319 });
    expect(m.svg.startsWith("<svg")).toBe(true);
    expect(m.svg).toContain('fill="hsl(40, 48%, 92%)"');
    expect(m.labels).toMatchObject({ width: 717, height: 319, labels: [] });
    // zoom 16 reads zoom-14 tiles (the planet tiles stop at 14)
    expect(asked.some((u) => /tiles\.test\/14\//.test(u))).toBe(true);
  });
});

describe("report date", () => {
  test("is the day in Amsterdam, not in UTC", () => {
    expect(amsterdamDate(new Date("2026-10-19T23:30:00Z"))).toBe("2026-10-20");
    expect(amsterdamDate(new Date("2026-10-19T12:00:00Z"))).toBe("2026-10-19");
  });
});
