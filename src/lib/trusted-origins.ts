/**
 * The origins a cookie-authenticated request may come from: TRUSTED_ORIGINS plus the app's own (BASE_URL).
 *
 * The CSRF guard, credentialed CORS and Better Auth all read env.TRUSTED_ORIGINS. A frontend served from the API's own
 * host (the Studio app, which mounts this API) sends its own origin on every write; with TRUSTED_ORIGINS unset the guard
 * answered 403 to all of them (studio.funderdata.nl, 2026-10-28, ~5.5 h). The app's own origin is never cross-site, so
 * it is always in the list, whatever the setting says.
 */
/** A comma-separated setting as a list of origins: trimmed, empty parts dropped. */
export function originList(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function withOwnOrigin(origins: readonly string[], baseUrl: string | undefined): string[] {
  if (!baseUrl) return [...origins];
  const own = new URL(baseUrl).origin;
  return origins.includes(own) ? [...origins] : [...origins, own];
}
