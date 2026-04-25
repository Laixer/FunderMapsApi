// .NET Identity v3 PBKDF2 hash compatibility.
//
// Format (base64-encoded binary):
//   [0x01]                  format marker
//   [PRF u32 BE]            0=HMACSHA1, 1=HMACSHA256, 2=HMACSHA512
//   [iter u32 BE]           PBKDF2 iterations
//   [saltLen u32 BE]        salt length in bytes
//   [salt]                  saltLen bytes
//   [subkey]                derived key (rest of buffer)
//
// .NET Identity v2 used a fixed 16-byte salt + 32-byte subkey with marker
// 0x00; we don't support v2 here because all 272 migrated hashes are v3
// (verified 2026-04-25; first char 'A' + second char in [Q-Z,a-f] →
// 0x01 marker).
import { pbkdf2Sync, timingSafeEqual } from "node:crypto";

const PRF_DIGEST = ["sha1", "sha256", "sha512"] as const;

/** Heuristic: pure base64 without a colon = legacy .NET Identity hash. */
export function looksLikeDotnetIdentity(hash: string): boolean {
  if (hash.includes(":")) return false;
  if (!/^[A-Za-z0-9+/]+=*$/.test(hash)) return false;
  return true;
}

/** Returns true if the password matches a .NET Identity v3 PBKDF2 hash. */
export function verifyDotnetIdentityV3(hashB64: string, password: string): boolean {
  let buf: Buffer;
  try {
    buf = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  if (buf.length < 13 || buf[0] !== 0x01) return false;

  const prf = buf.readUInt32BE(1);
  const iter = buf.readUInt32BE(5);
  const saltLen = buf.readUInt32BE(9);

  if (prf > 2) return false;
  if (iter < 1 || iter > 5_000_000) return false;
  if (saltLen < 8 || saltLen > 1024) return false;
  if (buf.length < 13 + saltLen + 1) return false;

  const salt = buf.subarray(13, 13 + saltLen);
  const subkey = buf.subarray(13 + saltLen);

  let derived: Buffer;
  try {
    derived = pbkdf2Sync(password, salt, iter, subkey.length, PRF_DIGEST[prf]!);
  } catch {
    return false;
  }

  return derived.length === subkey.length && timingSafeEqual(derived, subkey);
}

/**
 * Build a .NET Identity v3 hash for the given password. Test-only —
 * production paths use Better Auth's scrypt format for new passwords.
 */
export function hashDotnetIdentityV3(
  password: string,
  opts: { prf?: 0 | 1 | 2; iter?: number; saltLen?: number; subkeyLen?: number } = {},
): string {
  const prf = opts.prf ?? 1; // HMACSHA256 (.NET Identity v3 default)
  const iter = opts.iter ?? 10000;
  const saltLen = opts.saltLen ?? 16;
  const subkeyLen = opts.subkeyLen ?? 32;

  const salt = crypto.getRandomValues(new Uint8Array(saltLen));
  const subkey = pbkdf2Sync(password, Buffer.from(salt), iter, subkeyLen, PRF_DIGEST[prf]!);

  const buf = Buffer.alloc(13 + saltLen + subkeyLen);
  buf[0] = 0x01;
  buf.writeUInt32BE(prf, 1);
  buf.writeUInt32BE(iter, 5);
  buf.writeUInt32BE(saltLen, 9);
  Buffer.from(salt).copy(buf, 13);
  subkey.copy(buf, 13 + saltLen);

  return buf.toString("base64");
}
