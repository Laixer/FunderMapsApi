import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { env } from "../config.ts";
import { AppError, NotFoundError } from "../lib/errors.ts";
import { timingSafeEqual } from "node:crypto";
import { sendRiskFollowups } from "../lib/intake-risk-followup.ts";
import { createDossier, dossierSchema, lookupDossier, statusSchema } from "../lib/intake-dossier.ts";

/**
 * The intake lane behind a shared secret.
 *
 * Everything here arrives from the terugmeldformulier — an unauthenticated
 * stranger on a phone — so it is deliberately kept out of `/api/incident`,
 * which sits behind `authMiddleware`. Carving an exception inside an
 * already-authenticated prefix is how auth holes get made; a separate mount
 * with its own shared-secret check is easier to reason about and to revoke.
 *
 * Callers: the old melden app (FunderMapsIntake) for /dossier and /status, until
 * it is gone — the portal inside the Studio app uses the public
 * routes/submission.ts instead (2026-10-30) — and Windmill for /risk-followup.
 * What a submission becomes is lib/intake-dossier.ts, shared by both lanes.
 */
const intake = new Hono();

/** The shared secret the callers present. Nothing else may use this lane. */
intake.use("*", async (c, next) => {
  if (!env.INTAKE_TOKEN) throw new AppError(503, "Intake is not configured");
  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Length-independent compare; `timingSafeEqual` needs equal-length inputs.
  const ok =
    presented.length === env.INTAKE_TOKEN.length &&
    timingSafeEqual(
      new TextEncoder().encode(presented),
      new TextEncoder().encode(env.INTAKE_TOKEN),
    );
  if (!ok) throw new AppError(401, "Unauthorized");
  await next();
});

intake.post("/dossier", zValidator("json", dossierSchema), async (c) => {
  return c.json(await createDossier(c.req.valid("json")), 201);
});

intake.post("/status", zValidator("json", statusSchema), async (c) => {
  const { reference, email } = c.req.valid("json");
  const found = await lookupDossier(reference, email);
  if (!found) throw new NotFoundError();
  return c.json(found);
});

/**
 * The run after the model refresh (#143 option B): compare every closed
 * dossier's risk snapshot with the model's current row and mail the melder
 * once when it changed. Windmill calls this as the last step of the daily
 * refresh flow; safe to call any time, a snapshot is checked once.
 */
intake.post("/risk-followup", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { dry_run?: boolean; limit?: number };
  const result = await sendRiskFollowups({ dryRun: body.dry_run === true, limit: body.limit });
  return c.json(result);
});

export default intake;
