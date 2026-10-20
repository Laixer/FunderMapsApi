import { z } from "zod/v4";

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(10000).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * `limit` and `offset` of a list request, read from the query string.
 *
 * A value that is not a whole number of at least 1 (limit) or 0 (offset) falls
 * back to the default instead of reaching the query. `limit=abc` and
 * `limit=-1` used to return the whole table (all 31,474 rapportages, 27 MB) and
 * `offset=-1` a 500 from the database.
 *
 * There is no upper cap on purpose: a caller that asks for a large page with a
 * valid number keeps getting it.
 */
export function listPage(
  query: (name: string) => string | undefined,
  defaultLimit: number,
): { limit: number; offset: number } {
  const whole = (raw: string | undefined) => (raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  const limit = whole(query("limit"));
  const offset = whole(query("offset"));
  return {
    limit: Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_INT4 ? limit : defaultLimit,
    offset: Number.isSafeInteger(offset) && offset <= MAX_INT4 ? offset : 0,
  };
}

/** The largest value an `integer` column, a LIMIT or an OFFSET takes without a second look. */
const MAX_INT4 = 2_147_483_647;
