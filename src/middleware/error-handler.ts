import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError, ValidationError } from "../lib/errors.ts";

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

  console.error(err);
  return c.json({ message: "Internal server error" }, 500);
};
