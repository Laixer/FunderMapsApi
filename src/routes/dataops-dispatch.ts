import { Hono } from "hono";
import { ValidationError } from "../lib/errors.ts";
import { runDispatch } from "../lib/dispatch-run.ts";
import type { Mode } from "../lib/dispatch.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * POST /api/dataops/dispatch  { mode?: "new" | "drip" | "all", dryRun?: boolean }
 *
 * The review-queue dispatcher (#277): hands new meldingen and a day's worth
 * of older research to the people in dataops.staff_capacity, and takes back
 * what sat untouched (rules: lib/dispatch.ts). A Windmill schedule calls it as
 * the Fundie user -- mode "new" every hour after ingest_pending, "drip" once
 * in the morning -- the way close_qs_duplicates closes dossiers through the
 * API instead of with database grants of its own.
 *
 * Staff only (the /api/dataops guard): it does nothing a person could not do
 * with "Doorzetten", and does it by rules. dryRun defaults to TRUE, so a
 * stray call shows a plan and changes nothing; the schedule passes false.
 * Per-person targets and holdings (derived from someone's hours) are for
 * administrators only, like /dataops/team; others get the changes and counts.
 */
const routes = new Hono<AppEnv>();
const MODES = new Set<Mode>(["new", "drip", "all"]);

routes.post("/dispatch", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown; dryRun?: unknown };
  const mode = (body.mode ?? "new") as Mode;
  if (!MODES.has(mode)) throw new ValidationError(["mode must be new, drip or all"]);
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") throw new ValidationError(["dryRun must be true or false"]);
  const result = await runDispatch({ mode, dryRun: body.dryRun ?? true, actorId: user.id });
  if (user.role === "administrator") return c.json(result);
  const { people: _people, ...forStaff } = result;
  return c.json(forStaff);
});

export default routes;
