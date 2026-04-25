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

export function generateApiKey(): string {
  return `fmsk.${crypto.randomUUID().replaceAll("-", "")}`;
}
