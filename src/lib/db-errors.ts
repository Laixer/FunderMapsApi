// Telling "the database is briefly unreachable" apart from "this request
// broke", so a managed-PG failover or maintenance costs a few seconds of 503s
// instead of a process restart. Ported from FunderMapsWebservice
// (src/db-errors.ts), which crashed on exactly this on 2026-10-08.
//
// During a failover DO's PgBouncer answers `FATAL 08P01 server login has been
// failing ... (server_login_retry)` for a few seconds. postgres.js delivers
// that error to the request's query (a 500) and to an internal query it never
// awaits: the per-connection pg_type lookup behind `fetch_types`. That second
// rejection is unhandled, and Bun's default for an unhandled rejection is to
// exit the process.
//
// The Webservice turned `fetch_types` off. This API cannot: it reads and
// writes Postgres arrays through the driver. So here the cause stays and two
// things contain it:
//   - the error handler answers a connectivity error with 503 + Retry-After;
//   - the process-level unhandledRejection guard (src/index.ts) logs a stray
//     connectivity rejection and keeps serving, the pool reconnects on its
//     own, while every other unhandled rejection still exits as before.

import postgres from "postgres";

/** The Retry-After a client gets while the database is unreachable. */
export const DATABASE_RETRY_AFTER_SECONDS = 10;

// SQLSTATEs that mean "the database, or the PgBouncer in front of it, can't
// serve anyone right now" rather than "this query is wrong":
//   08xxx  connection_exception. PgBouncer reports all of its own failures as
//          08P01: server_login_retry (the 2026-10-08 failover),
//          query_wait_timeout, "no more connections allowed", ...
//   57P01  admin_shutdown       (the primary is being stopped: failover)
//   57P02  crash_shutdown
//   57P03  cannot_connect_now   (the node is still starting up)
//   53300  too_many_connections
const UNAVAILABLE_SQLSTATE = /^08|^57P0[123]$|^53300$/;

// Errors without a SQLSTATE: postgres.js' own connection errors, and the
// socket/DNS errors Bun surfaces through it.
const UNAVAILABLE_CONNECTION_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * The driver's error behind whatever reached us. Drizzle wraps a failed query
 * in a DrizzleQueryError whose `cause` is the driver's error, so the SQLSTATE
 * sits one level down; a few levels are followed, no more.
 */
function driverError(err: unknown): unknown {
  let e = err;
  for (let depth = 0; depth < 4; depth++) {
    if (e instanceof postgres.PostgresError) return e;
    const cause = (e as { cause?: unknown } | null | undefined)?.cause;
    if (cause == null) return e;
    e = cause;
  }
  return e;
}

export function isDatabaseUnavailable(err: unknown): boolean {
  const e = driverError(err);
  if (e instanceof postgres.PostgresError) return UNAVAILABLE_SQLSTATE.test(e.code);
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && UNAVAILABLE_CONNECTION_CODES.has(code);
}

/** One JSON log line per connectivity error, instead of a stack trace per request. */
export function logDatabaseUnavailable(
  source: "request" | "unhandled_rejection",
  err: unknown,
  extra: Record<string, unknown> = {},
) {
  const e = driverError(err) as { code?: unknown; message?: unknown } | null | undefined;
  console.error(
    JSON.stringify({
      event: "database_unavailable",
      source,
      ...extra,
      code: e?.code,
      message: String(e?.message ?? err),
    }),
  );
}

/**
 * The process-level `unhandledRejection` listener. Bun's default for an
 * unhandled rejection is to print it and exit 1; that stays the behaviour for
 * everything except a database connectivity error, so real bugs still crash
 * loudly instead of being swallowed.
 */
export function handleUnhandledRejection(
  reason: unknown,
  exit: (code: number) => void = (code) => process.exit(code),
) {
  if (isDatabaseUnavailable(reason)) {
    logDatabaseUnavailable("unhandled_rejection", reason);
    return;
  }
  console.error(reason);
  exit(1);
}
