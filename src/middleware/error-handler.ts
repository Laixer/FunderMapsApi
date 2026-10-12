import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError, ValidationError } from "../lib/errors.ts";
import { DATABASE_RETRY_AFTER_SECONDS, isDatabaseUnavailable, logDatabaseUnavailable } from "../lib/db-errors.ts";

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ValidationError) {
    return c.json(
      { message: err.message, errors: err.errors },
      err.statusCode as ContentfulStatusCode,
    );
  }

  if (err instanceof AppError) {
    return c.json(
      { message: err.message },
      err.statusCode as ContentfulStatusCode,
    );
  }

  // The database dropped out from under the request (failover, maintenance):
  // not a bug in this request, so 503 with a retry hint rather than a 500.
  // See lib/db-errors.ts.
  if (isDatabaseUnavailable(err)) {
    logDatabaseUnavailable("request", err, { method: c.req.method, path: new URL(c.req.url).pathname });
    c.header("Retry-After", String(DATABASE_RETRY_AFTER_SECONDS));
    return c.json(
      { message: `The service is temporarily unavailable. Retry after ${DATABASE_RETRY_AFTER_SECONDS} seconds.` },
      503,
    );
  }

  console.error(err);
  return c.json({ message: "Internal server error" }, 500);
};
