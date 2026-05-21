// Shared API-key utilities for the dual-write/dual-read transition.
// Hashing happens in the app layer so the DB needs no extension.

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Better Auth stores OAuth access tokens (and api keys) as the base64url,
// unpadded SHA-256 of the plaintext — its `defaultHasher`. Resource-server
// token introspection must hash the incoming bearer the same way before
// looking it up in application.oauth_access_token.
export async function sha256Base64Url(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Buffer.from(buf).toString("base64url");
}

export function generateApiKey(): string {
  return `fmsk.${crypto.randomUUID().replaceAll("-", "")}`;
}
