import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { DATABASE_RETRY_AFTER_SECONDS, handleUnhandledRejection, isDatabaseUnavailable } from "./db-errors.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { ValidationError } from "./errors.ts";

// A database blip (managed-PG failover, maintenance) must cost a few 503s,
// never the process (the Webservice went down on this on 2026-10-08). Pinned
// here: which errors count as "the database is unreachable", the 503 +
// Retry-After the error handler gives for them, and the unhandled-rejection
// guard that keeps the process alive. The driver regression against a fake
// PgBouncer lives in src/db/client.test.ts.

const pgError = (code: string, message = "boom") =>
  new postgres.PostgresError({ code, message, severity: "FATAL" } as never);
const withCode = (code: string) => Object.assign(new Error(`write ${code} db:25061`), { code });
/** A failed query as Drizzle hands it on: its own error, the driver's as `cause`. */
const viaDrizzle = (cause: Error) => new DrizzleQueryError("select 1", [], cause);

// The exact error the Webservice died on.
const LOGIN_FAILING = pgError(
  "08P01",
  "server login has been failing, cached error: connect failed (server_login_retry)",
);

let errorLog: ReturnType<typeof spyOn>;
beforeEach(() => {
  errorLog = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

describe("isDatabaseUnavailable", () => {
  test("PgBouncer's failover error and the other connection-class SQLSTATEs", () => {
    expect(isDatabaseUnavailable(LOGIN_FAILING)).toBe(true);
    for (const code of ["08000", "08006", "08001", "57P01", "57P02", "57P03", "53300"]) {
      expect(isDatabaseUnavailable(pgError(code))).toBe(true);
    }
  });

  test("the same errors wrapped by Drizzle", () => {
    expect(isDatabaseUnavailable(viaDrizzle(LOGIN_FAILING))).toBe(true);
    expect(isDatabaseUnavailable(viaDrizzle(withCode("CONNECTION_CLOSED")))).toBe(true);
    expect(isDatabaseUnavailable(viaDrizzle(pgError("23505")))).toBe(false);
  });

  test("a query error is not an outage", () => {
    for (const code of ["42P01", "42703", "22P02", "57014", "23505", "25006"]) {
      expect(isDatabaseUnavailable(pgError(code))).toBe(false);
    }
  });

  test("postgres.js connection errors and socket/DNS errors", () => {
    for (const code of ["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED", "CONNECT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND"]) {
      expect(isDatabaseUnavailable(withCode(code))).toBe(true);
    }
  });

  test("anything else is not", () => {
    for (const reason of [new Error("boom"), withCode("UNDEFINED_VALUE"), new TypeError("x is undefined"), new ValidationError(["x"]), "string", null, undefined, 42]) {
      expect(isDatabaseUnavailable(reason)).toBe(false);
    }
  });
});

describe("handleUnhandledRejection", () => {
  test("a connectivity rejection is logged as one JSON line and the process lives", () => {
    const exit = mock((_code: number) => {});
    handleUnhandledRejection(LOGIN_FAILING, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorLog.mock.calls[0]![0] as string)).toEqual({
      event: "database_unavailable",
      source: "unhandled_rejection",
      code: "08P01",
      message: "server login has been failing, cached error: connect failed (server_login_retry)",
    });
  });

  test("any other rejection keeps Bun's default: print it, exit 1", () => {
    const exit = mock((_code: number) => {});
    const bug = new TypeError("cannot read properties of undefined");
    handleUnhandledRejection(bug, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorLog).toHaveBeenCalledWith(bug);
  });
});

describe("the error handler", () => {
  const appThatThrows = (err: unknown) => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/api/thing", () => {
      throw err;
    });
    return app;
  };

  test("database unreachable: 503 with Retry-After, one log line, no stack trace", async () => {
    const res = await appThatThrows(viaDrizzle(LOGIN_FAILING)).request("/api/thing");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe(String(DATABASE_RETRY_AFTER_SECONDS));
    expect(((await res.json()) as { message: string }).message).toContain(`${DATABASE_RETRY_AFTER_SECONDS} seconds`);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorLog.mock.calls[0]![0] as string)).toEqual({
      event: "database_unavailable",
      source: "request",
      method: "GET",
      path: "/api/thing",
      code: "08P01",
      message: "server login has been failing, cached error: connect failed (server_login_retry)",
    });
  });

  test("a query error stays a 500", async () => {
    const res = await appThatThrows(viaDrizzle(pgError("42703", "column does not exist"))).request("/api/thing");
    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(await res.json()).toEqual({ message: "Internal server error" });
  });

  test("a validation error stays a 400", async () => {
    const res = await appThatThrows(new ValidationError(["id must be a number"])).request("/api/thing");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "Validation failed", errors: ["id must be a number"] });
  });
});
