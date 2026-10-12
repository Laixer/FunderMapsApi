import { describe, test, expect, afterAll } from "bun:test";

// Regression test for the crash the Webservice had on 2026-10-08 and this API
// could have had on the same day (see src/lib/db-errors.ts).
//
// During a managed-PG failover DO's PgBouncer logs a client in on its own,
// queues its first query ("No server connection available ..., client being
// queued") and then fails it with FATAL 08P01 "server login has been failing
// ... (server_login_retry)". With postgres.js' fetch_types, which this API
// needs for arrays, that first query is the driver's own, un-awaited pg_type
// lookup: its rejection is unhandled, and an unhandled rejection exits a
// `bun run` process.
//
// The fake PgBouncer below does exactly that, and the real src/db/client.ts
// runs in a child process with the real guard from src/lib/db-errors.ts
// installed the way src/index.ts installs it. The query failing is expected;
// the process exiting is the bug.

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");
const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const fields = (f: Record<string, string>) =>
  Buffer.concat([...Object.entries(f).map(([k, v]) => Buffer.concat([Buffer.from(k, "latin1"), cstr(v)])), Buffer.from([0])]);

const LOGIN_OK = Buffer.concat([
  message("R", int32(0)), // AuthenticationOk
  message("S", Buffer.concat([cstr("server_version"), cstr("18.0")])),
  message("S", Buffer.concat([cstr("client_encoding"), cstr("UTF8")])),
  message("K", Buffer.concat([int32(1), int32(2)])), // BackendKeyData
  message("Z", Buffer.from("I", "latin1")), // ReadyForQuery
]);
const QUEUED = message("N", fields({
  S: "NOTICE",
  V: "NOTICE",
  C: "00000",
  M: "No server connection available in postgres backend, client being queued",
}));
const LOGIN_FAILING = message("E", fields({
  S: "FATAL",
  V: "FATAL",
  C: "08P01",
  M: "server login has been failing, cached error: connect failed (server_login_retry)",
}));

const bouncer = Bun.listen<{ loggedIn: boolean }>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(s) {
      s.data = { loggedIn: false };
    },
    data(s) {
      if (!s.data.loggedIn) {
        s.data.loggedIn = true;
        s.write(LOGIN_OK);
        return;
      }
      s.write(Buffer.concat([QUEUED, LOGIN_FAILING]));
      s.end();
    },
  },
});

afterAll(() => bouncer.stop(true));

/** Run src/db/client.ts against the fake PgBouncer in a child process and report what happened. */
async function runChild(guard: "the guard of src/index.ts" | "no guard") {
  const clientModule = new URL("./client.ts", import.meta.url).pathname;
  const guardModule = new URL("../lib/db-errors.ts", import.meta.url).pathname;
  // An unhandled rejection is what exits a `bun run` process (prod), but a
  // child of `bun test` only prints it, so the child exits on one explicitly:
  // 70 = the process would have died.
  const listener =
    guard === "no guard"
      ? `process.on("unhandledRejection", (reason) => { console.log("unhandled: " + reason?.code); process.exit(70); });`
      : `const { handleUnhandledRejection } = await import(${JSON.stringify(guardModule)});
         process.on("unhandledRejection", (reason) => { console.log("guard saw: " + reason?.code); handleUnhandledRejection(reason, () => process.exit(70)); });`;
  const child = `
    ${listener}
    const { db } = await import(${JSON.stringify(clientModule)});
    const { sql } = await import("drizzle-orm");
    try {
      await db.execute(sql\`select 1\`);
      console.log("query succeeded");
    } catch (err) {
      console.log("query rejected: " + (err?.cause?.code ?? err?.code ?? err?.message));
    }
    // Give a stray rejection time to surface before calling it survived.
    await Bun.sleep(500);
    console.log("still alive");
    process.exit(0);
  `;
  const proc = Bun.spawn([process.execPath, "-e", child], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...process.env,
      DATABASE_URL: `postgres://api@127.0.0.1:${bouncer.port}/fundermaps?sslmode=disable`,
      APP_ID: "test",
      AUTH_SECRET: "test-secret",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout };
}

describe("src/db/client.ts during a PgBouncer login-failure window", () => {
  test("without a guard the driver's stray rejection would exit the process", async () => {
    const { exitCode, stdout } = await runChild("no guard");
    expect(stdout).toContain("unhandled: 08P01");
    expect(exitCode).toBe(70);
  }, 15_000);

  test("with the guard the query fails and the process survives", async () => {
    const { exitCode, stdout } = await runChild("the guard of src/index.ts");
    expect(stdout).toContain("query rejected: 08P01");
    expect(stdout).toContain("guard saw: 08P01");
    expect(stdout).toContain("still alive");
    expect(exitCode).toBe(0);
  }, 15_000);
});
