import { env } from "../config.ts";

/**
 * Run a Windmill script, fire and forget.
 *
 * The one caller is the Studio upload: a reviewer who just dropped a report
 * wants to judge it now, not after the next hourly `ingest_pending` sweep.
 * Windmill resolves `$res:` / `$var:` strings in the args itself, so no
 * secret passes through here. Every failure is logged and swallowed: the
 * sweep will read the dossier anyway, and an upload must never be lost
 * because the orchestrator was busy.
 */
export async function runScript(path: string, args: Record<string, unknown>): Promise<string | null> {
  if (!env.WINDMILL_TOKEN) return null;
  const url = `${env.WINDMILL_URL}/api/w/${env.WINDMILL_WORKSPACE}/jobs/run/p/${path}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WINDMILL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      console.error(`windmill: ${path} -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    return (await r.text()).trim();
  } catch (e) {
    console.error(`windmill: ${path} -> ${String(e).slice(0, 200)}`);
    return null;
  }
}

/** Read one dossier through the pipeline now. Returns the Windmill job id, or null when not triggered. */
export function ingestDossierNow(dossierId: number): Promise<string | null> {
  return runScript("f/fundermaps/dataops/ingest_pending", {
    pg: "$res:f/fundermaps/managed_pg",
    s3: "$res:f/fundermaps/s3",
    openrouter: "$var:f/fundermaps/openrouter_api_key",
    limit: 1,
    dossier_id: dossierId,
  });
}
