import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { NotFoundError } = await import("../lib/errors.ts");
const { errorHandler } = await import("../middleware/error-handler.ts");
const { default: pdf, deps } = await import("./pdf.ts");

// POST /api/pdf/:id makes the report with Typst; a Typst failure is a 502 (there is no second engine any more),
// missing data a 404. The engine and the billing step are swapped on `deps` for one test and put back after;
// nothing renders, connects or bills.

const saved = { ...deps };
afterEach(() => {
  Object.assign(deps, saved);
});

const PAND = "NL.IMBAG.PAND.0363100012066783";
function setup(typst: (id: string) => Promise<unknown>) {
  const calls = { typst: [] as string[], track: [] as string[] };
  deps.renderTypst = (async (id: string) => {
    calls.typst.push(id);
    return typst(id);
  }) as typeof deps.renderTypst;
  deps.track = async (buildingId: string) => {
    calls.track.push(buildingId);
  };
  const app = new Hono();
  app.onError(errorHandler);
  app.use(async (c, next) => {
    c.set("user" as never, { id: "a0000000-0000-4000-8000-000000000001", organizations: [] } as never);
    await next();
  });
  app.route("/", pdf);
  return { app, calls };
}
const typstReport = async () => ({
  buildingId: PAND,
  pdf: new TextEncoder().encode("%PDF-typst"),
  ms: { data: 1, maps: 2, typst: 3 },
});

describe("POST /api/pdf/:id", () => {
  test("makes the report with Typst and writes its billing rows", async () => {
    const { app, calls } = setup(typstReport);
    const res = await app.request(`/${PAND}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Engine")).toBe("typst");
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(await res.text()).toBe("%PDF-typst");
    expect(calls).toEqual({ typst: [PAND], track: [PAND] });
  });

  test("a Typst failure is a 502 and bills nothing", async () => {
    const { app, calls } = setup(async () => {
      throw new Error("typst exited with 1");
    });
    const res = await app.request(`/${PAND}`, { method: "POST" });
    expect(res.status).toBe(502);
    expect(calls.track).toEqual([]);
  });

  test("missing report data is a 404", async () => {
    const { app, calls } = setup(async () => {
      throw new NotFoundError("No report data");
    });
    const res = await app.request(`/${PAND}`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(calls.track).toEqual([]);
  });

  test("the old ?engine=gotenberg is ignored: Typst makes the report", async () => {
    const { app, calls } = setup(typstReport);
    const res = await app.request(`/${PAND}?engine=gotenberg`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Engine")).toBe("typst");
    expect(calls.typst).toEqual([PAND]);
  });
});
