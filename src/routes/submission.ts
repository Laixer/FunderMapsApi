import { Hono } from "hono";
import { AppError } from "../lib/errors.ts";
import { createDossier, lookupDossier } from "../lib/intake-dossier.ts";
import { getUploadUrl, objectExists } from "../lib/s3.ts";
import { clientIp, requireHuman, throttle, Throttle } from "../lib/public-guards.ts";
import { isEmail, MELDCODE, planUpload, toDossierInput } from "../lib/submission-rules.ts";

/**
 * The melden portal's routes, public (2026-10-30). Until now the melden app
 * (FunderMapsIntake) had these three in its own server and called the token
 * lane routes/intake.ts; with the portal inside the Studio app its pages call
 * the API directly, so the routes move here and the shared secret between the
 * two goes once the old app is deleted.
 *
 * Anyone may call them — a stranger on a phone — so each one is guarded: a
 * per-IP speed bump, Turnstile on the two that write (lib/public-guards.ts), and
 * the rules of lib/submission-rules.ts. The answers carry Dutch messages: the
 * portal shows them as they are.
 *
 *   POST /api/submission/upload-url  { name, size, type }      → { url, key }
 *   POST /api/submission              the form                  → { meldcode }
 *   POST /api/submission/status      { meldcode, email }       → the melding's state
 */
const submission = new Hono();

// Per IP, per minute. Submit is 30, not 10: a real melder submits once, but
// testers and an office behind one NAT address share the bucket (Don hit 10 on
// 2026-09-11). A speed bump against a script, not a security control.
const UPLOADS = new Throttle(40, 60_000);
const SUBMITS = new Throttle(30, 60_000);
const LOOKUPS = new Throttle(20, 60_000);

submission.post("/upload-url", async (c) => {
  throttle(UPLOADS, c);
  await requireHuman(c);
  const { key, type, size } = planUpload(await c.req.json().catch(() => ({})));
  return c.json({ url: await getUploadUrl(key, type, size, 900), key });
});

submission.post("/", async (c) => {
  throttle(SUBMITS, c);
  await requireHuman(c);
  const input = toDossierInput(await c.req.json().catch(() => null), {
    ip: clientIp((n) => c.req.header(n)),
    agent: c.req.header("user-agent") ?? null,
    referrer: c.req.header("referer") ?? null,
  });
  for (const a of input.attachments) {
    if (!(await objectExists(a.key))) throw new AppError(400, "Een bijlage is niet aangekomen");
  }
  try {
    // "Meldcode" is the word the melder reads; `reference` is what the
    // database calls it. The mapping lives here and nowhere else.
    const { reference } = await createDossier(input);
    return c.json({ meldcode: reference }, 201);
  } catch (err) {
    // Never the internal detail: the melder can do nothing with it.
    console.error("submission failed", err instanceof Error ? err.message : err);
    throw new AppError(502, "Melding kon niet worden opgeslagen");
  }
});

/**
 * One melding, by meldcode plus the email that made it. Every failure is the
 * same 404, whichever half was wrong: a distinguishable "wrong email" would
 * turn this into a way to enumerate which meldcodes exist.
 */
submission.post("/status", async (c) => {
  throttle(LOOKUPS, c);
  const body = (await c.req.json().catch(() => ({}))) as { meldcode?: unknown; email?: unknown };
  const meldcode = String(body.meldcode ?? "").trim();
  const email = String(body.email ?? "").trim();
  const notFound = new AppError(404, "Niet gevonden");
  if (!MELDCODE.test(meldcode) || !isEmail(email)) throw notFound;
  const found = await lookupDossier(meldcode, email).catch(() => null);
  if (!found) throw notFound;
  return c.json({ ...found, meldcode: found.reference });
});

export default submission;
