import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { env } = await import("../config.ts");
const { NotFoundError } = await import("../lib/errors.ts");
const { errorHandler } = await import("../middleware/error-handler.ts");
const { default: pdf, deps } = await import("./pdf.ts");

// POST /api/pdf/:id makes the report with Typst by default and with Gotenberg on ?engine=gotenberg; a Typst
// failure falls back to Gotenberg, missing data does not. The engines, the billing step and the call to
// Gotenberg are swapped on `deps` for one test and put back after; nothing renders, connects or bills.

const saved = { ...deps };
const savedEnv = { PDF_ENGINE: env.PDF_ENGINE, GOTENBERG_URL: env.GOTENBERG_URL };
afterEach(() => {
  Object.assign(deps, saved);
  Object.assign(env, savedEnv);
});

const PAND = "NL.IMBAG.PAND.0363100012066783";
function setup(typst: (id: string) => Promise<unknown>) {
  const calls = { typst: [] as string[], track: [] as string[], gotenberg: [] as string[] };
  Object.assign(env, { GOTENBERG_URL: "https://gotenberg.test" });
  deps.renderTypst = (async (id: string) => {
    calls.typst.push(id);
    return typst(id);
  }) as typeof deps.renderTypst;
  deps.track = async (buildingId: string) => {
    calls.track.push(buildingId);
  };
  deps.fetch = async (url: string) => {
    calls.gotenberg.push(url);
    return new Response("%PDF-gotenberg", { status: 200 });
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
  test("makes the report with Typst by default and writes its billing rows", async () => {
    const { app, calls } = setup(typstReport);
    const res = await app.request(`/${PAND}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Engine")).toBe("typst");
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(await res.text()).toBe("%PDF-typst");
    expect(calls).toEqual({ typst: [PAND], track: [PAND], gotenberg: [] });
  });

  test("?engine=gotenberg takes the old path: Gotenberg, no Typst, no extra billing", async () => {
    const { app, calls } = setup(typstReport);
    const res = await app.request(`/${PAND}?engine=gotenberg`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Engine")).toBe("gotenberg");
    expect(await res.text()).toBe("%PDF-gotenberg");
    expect(calls.typst).toEqual([]);
    expect(calls.track).toEqual([]);
    expect(calls.gotenberg).toEqual(["https://gotenberg.test/forms/chromium/convert/url"]);
  });

  test("a Typst failure falls back to Gotenberg, so the user still gets a report", async () => {
    const { app, calls } = setup(async () => {
      throw new Error("typst exited with 1");
    });
    const res = await app.request(`/${PAND}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Engine")).toBe("gotenberg");
    expect(calls.gotenberg.length).toBe(1);
    expect(calls.track).toEqual([]);
  });

  test("missing report data is a 404, not a second try through Gotenberg", async () => {
    const { app, calls } = setup(async () => {
      throw new NotFoundError("No report data");
    });
    const res = await app.request(`/${PAND}`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(calls.gotenberg).toEqual([]);
  });

  test("PDF_ENGINE=gotenberg makes Gotenberg the default; ?engine=typst still asks for Typst", async () => {
    const { app, calls } = setup(typstReport);
    Object.assign(env, { PDF_ENGINE: "gotenberg" });
    expect((await app.request(`/${PAND}`, { method: "POST" })).headers.get("X-Pdf-Engine")).toBe("gotenberg");
    expect((await app.request(`/${PAND}?engine=typst`, { method: "POST" })).headers.get("X-Pdf-Engine")).toBe("typst");
    expect(calls.typst).toEqual([PAND]);
  });

  test("an unknown ?engine is ignored", async () => {
    const { app } = setup(typstReport);
    expect((await app.request(`/${PAND}?engine=chromium`, { method: "POST" })).headers.get("X-Pdf-Engine")).toBe("typst");
  });
});
