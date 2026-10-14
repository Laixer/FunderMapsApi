import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { db } = await import("../db/client.ts");
const { default: dataops } = await import("./dataops.ts");

// The hand-over writes its Verloop line with the colleague's name in it, and the line is stored as
// written: "Doorgezet naar <name>". The account's `name` holds the e-mail address for most people,
// so the given and family name come first, as on every other place staff see a person.
//
// The route runs as it is; only the database is answered here. Its methods are replaced on the
// `db` object for one test and put back after, so nothing connects and no other test sees them.

type Rows = unknown[];
const patched: string[] = [];
function answer(method: "select" | "update" | "insert", rows: () => Rows, onValues?: (v: unknown) => void) {
  const chain = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, key) =>
        key === "then"
          ? (resolve: (v: Rows) => void) => resolve(rows())
          : (arg: unknown) => {
              if (key === "values") onValues?.(arg);
              return chain();
            },
    });
  (db as unknown as Record<string, unknown>)[method] = () => chain();
  patched.push(method);
}
afterEach(() => {
  for (const m of patched.splice(0)) delete (db as unknown as Record<string, unknown>)[m];
});

const COLLEAGUE = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

async function handOver(colleague: Record<string, unknown>, body: Record<string, unknown> = { userId: COLLEAGUE }) {
  const selects: Rows[] = [[{ id: 7, assignedTo: null }], [colleague]];
  answer("select", () => selects.shift() ?? []);
  answer("update", () => []);
  const entries: { text: string; body: unknown }[] = [];
  answer("insert", () => [], (v) => entries.push(v as { text: string; body: unknown }));

  const app = new Hono();
  app.use(async (c, next) => {
    c.set("user" as never, { id: "a0000000-0000-4000-8000-000000000001" } as never);
    await next();
  });
  app.route("/", dataops);
  const res = await app.request("/dossier/7/assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return entries;
}

describe("POST /dossier/:id/assign: the Verloop line names the colleague", () => {
  test("by the given and family name, not the address in `name`", async () => {
    const [entry] = await handOver({ name: "jan@example.test", givenName: "Jan", lastName: "Jansen", email: "jan@example.test" });
    expect(entry!.text).toBe("Doorgezet naar Jan Jansen");
  });

  test("the note follows the name", async () => {
    const [entry] = await handOver(
      { name: "jan@example.test", givenName: "Jan", lastName: "de Vries", email: "jan@example.test" },
      { userId: COLLEAGUE, note: "Kun jij de meetstaat nakijken?" },
    );
    expect(entry!.text).toBe("Doorgezet naar Jan de Vries: Kun jij de meetstaat nakijken?");
  });

  test("without a given or family name: `name` when it is a name, else the address", async () => {
    expect((await handOver({ name: "J. Jansen", givenName: null, lastName: null, email: "jan@example.test" }))[0]!.text).toBe(
      "Doorgezet naar J. Jansen",
    );
    expect((await handOver({ name: "jan@example.test", givenName: null, lastName: null, email: "jan@example.test" }))[0]!.text).toBe(
      "Doorgezet naar jan@example.test",
    );
  });

  test("what is kept with the line is unchanged: who it went to, by id", async () => {
    const [entry] = await handOver({ name: "jan@example.test", givenName: "Jan", lastName: "Jansen", email: "jan@example.test" });
    expect(entry!.body).toEqual({ assignment: { to: COLLEAGUE, from: null } });
  });
});
