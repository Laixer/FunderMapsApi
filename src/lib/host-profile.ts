/**
 * The map's host, on an app that serves this API on two hosts (FunderMapsStudio #18).
 *
 * The Studio app mounts this API on its own host (studio.funderdata.nl) and, since api-prod folded into it, on
 * api.fundermaps.com: the map's API, which the map's login, FunderConsult's push, Windmill and Resend's webhook call.
 * The two hosts share the database, the secret, the keys and the sessions. They differ in what belongs to a host: the
 * base URL Better Auth builds its links from, the passkey relying party (the map's passkeys are for fundermaps.com, the
 * Studio's for studio.funderdata.nl) and the app id the map's saved state is filed under. MAP_BASE_URL names the map's
 * host; unset (api-prod), there is one host, as before.
 */
export function isOnHost(requestUrl: string, baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return new URL(requestUrl).host === new URL(baseUrl).host;
}
