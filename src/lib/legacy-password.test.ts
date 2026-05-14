import { describe, test, expect } from "bun:test";
import { pbkdf2Sync } from "node:crypto";
import {
  hashDotnetIdentityV3,
  looksLikeDotnetIdentity,
  looksLikeFunderMapsCustom,
  verifyDotnetIdentityV3,
  verifyFunderMapsCustom,
} from "./legacy-password.ts";

// These verifiers are security-sensitive: they gate sign-in for ~272 users
// still on legacy hashes. The auto-upgrade hook in src/lib/auth.ts rewrites
// each successful verify into a BA scrypt hash, so the legacy paths become
// dead code once `SELECT count(*) FROM application.account WHERE
// provider_id='credential' AND password NOT LIKE '%:%'` hits 0. Pin the
// behavior now so the eventual Phase D deletion is a true diff: no logic
// change is allowed to ride along on the rip-out.

// Build a FunderMaps-custom-format hash from scratch using the exact
// parameters documented in PasswordHasher.cs (mirrored in legacy-password.ts):
//   [0x01] [16-byte salt] [32-byte subkey], PBKDF2 HMACSHA256, 10000 iters.
function makeFunderMapsCustomHash(password: string, salt?: Buffer): string {
  const s = salt ?? Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  const subkey = pbkdf2Sync(password, s, 10_000, 32, "sha256");
  const buf = Buffer.alloc(49);
  buf[0] = 0x01;
  s.copy(buf, 1);
  subkey.copy(buf, 17);
  return buf.toString("base64");
}

describe("looksLikeDotnetIdentity", () => {
  test("accepts pure base64 with no colon", () => {
    expect(looksLikeDotnetIdentity("AQAAAAEAACcQ")).toBe(true);
  });

  test("rejects BA scrypt format (salt:hash with colon)", () => {
    expect(looksLikeDotnetIdentity("abc123:def456")).toBe(false);
  });

  test("rejects strings with non-base64 characters", () => {
    expect(looksLikeDotnetIdentity("not!base64@")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(looksLikeDotnetIdentity("")).toBe(false);
  });

  test("accepts trailing '=' padding", () => {
    expect(looksLikeDotnetIdentity("YWJjZGVm==")).toBe(true);
  });
});

describe("looksLikeFunderMapsCustom", () => {
  test("accepts exactly 68 chars of valid base64 (49 bytes encoded)", () => {
    const hash = makeFunderMapsCustomHash("password");
    expect(hash.length).toBe(68); // sanity: confirms our test fixture
    expect(looksLikeFunderMapsCustom(hash)).toBe(true);
  });

  test("rejects too-short hash", () => {
    expect(looksLikeFunderMapsCustom("AQAAAAEAACcQ")).toBe(false);
  });

  test("rejects too-long hash", () => {
    const padded = makeFunderMapsCustomHash("password") + "AB";
    expect(looksLikeFunderMapsCustom(padded)).toBe(false);
  });

  test("rejects BA scrypt format", () => {
    expect(looksLikeFunderMapsCustom("a".repeat(34) + ":" + "b".repeat(34))).toBe(false);
  });

  test("rejects strings with non-base64 characters", () => {
    expect(looksLikeFunderMapsCustom("!".repeat(68))).toBe(false);
  });

  test("rejects empty string", () => {
    expect(looksLikeFunderMapsCustom("")).toBe(false);
  });
});

describe("verifyFunderMapsCustom", () => {
  test("returns true for the correct password", () => {
    const hash = makeFunderMapsCustomHash("hunter2");
    expect(verifyFunderMapsCustom(hash, "hunter2")).toBe(true);
  });

  test("returns false for a wrong password", () => {
    const hash = makeFunderMapsCustomHash("hunter2");
    expect(verifyFunderMapsCustom(hash, "hunter3")).toBe(false);
  });

  test("returns false when format marker is not 0x01", () => {
    // Build a 49-byte buffer whose first byte is 0x02 instead of 0x01.
    const salt = Buffer.alloc(16, 0);
    const subkey = pbkdf2Sync("pw", salt, 10_000, 32, "sha256");
    const buf = Buffer.alloc(49);
    buf[0] = 0x02; // wrong marker
    salt.copy(buf, 1);
    subkey.copy(buf, 17);
    expect(verifyFunderMapsCustom(buf.toString("base64"), "pw")).toBe(false);
  });

  test("returns false for hash with wrong byte length", () => {
    // 48 bytes — one short of the fixed FM format.
    const short = Buffer.alloc(48, 0);
    short[0] = 0x01;
    expect(verifyFunderMapsCustom(short.toString("base64"), "pw")).toBe(false);
  });

  test("returns false for empty input", () => {
    expect(verifyFunderMapsCustom("", "pw")).toBe(false);
  });

  test("password is case-sensitive", () => {
    const hash = makeFunderMapsCustomHash("HunteR2");
    expect(verifyFunderMapsCustom(hash, "hunter2")).toBe(false);
    expect(verifyFunderMapsCustom(hash, "HunteR2")).toBe(true);
  });

  test("salt difference produces different hashes for the same password", () => {
    const saltA = Buffer.alloc(16, 0x11);
    const saltB = Buffer.alloc(16, 0x22);
    const hashA = makeFunderMapsCustomHash("same", saltA);
    const hashB = makeFunderMapsCustomHash("same", saltB);
    expect(hashA).not.toBe(hashB);
    expect(verifyFunderMapsCustom(hashA, "same")).toBe(true);
    expect(verifyFunderMapsCustom(hashB, "same")).toBe(true);
  });
});

describe("verifyDotnetIdentityV3 (roundtrip with hashDotnetIdentityV3)", () => {
  test("default opts (HMACSHA256, 10000 iters) — correct password verifies", () => {
    const hash = hashDotnetIdentityV3("password");
    expect(verifyDotnetIdentityV3(hash, "password")).toBe(true);
  });

  test("default opts — wrong password rejected", () => {
    const hash = hashDotnetIdentityV3("password");
    expect(verifyDotnetIdentityV3(hash, "wrong")).toBe(false);
  });

  // The three PRF discriminators are the v3 format's branch points; each
  // maps to a different HMAC digest. Round-trip them all.
  test("PRF=0 (HMACSHA1) roundtrip", () => {
    const hash = hashDotnetIdentityV3("pw", { prf: 0 });
    expect(verifyDotnetIdentityV3(hash, "pw")).toBe(true);
    expect(verifyDotnetIdentityV3(hash, "PW")).toBe(false);
  });

  test("PRF=1 (HMACSHA256) roundtrip", () => {
    const hash = hashDotnetIdentityV3("pw", { prf: 1 });
    expect(verifyDotnetIdentityV3(hash, "pw")).toBe(true);
  });

  test("PRF=2 (HMACSHA512) roundtrip", () => {
    const hash = hashDotnetIdentityV3("pw", { prf: 2 });
    expect(verifyDotnetIdentityV3(hash, "pw")).toBe(true);
  });

  test("non-default iter count roundtrips", () => {
    const hash = hashDotnetIdentityV3("pw", { iter: 1 });
    expect(verifyDotnetIdentityV3(hash, "pw")).toBe(true);
  });

  test("non-default salt + subkey lengths roundtrip", () => {
    const hash = hashDotnetIdentityV3("pw", { saltLen: 32, subkeyLen: 64 });
    expect(verifyDotnetIdentityV3(hash, "pw")).toBe(true);
  });
});

describe("verifyDotnetIdentityV3 (bounds + bad input)", () => {
  // The bounds are deliberate DoS guards. A malicious hash that claims
  // iter=4_000_000_000 would otherwise burn CPU for ages.
  function craftHash(prf: number, iter: number, saltLen: number, subkeyLen: number): string {
    const buf = Buffer.alloc(13 + saltLen + subkeyLen);
    buf[0] = 0x01;
    buf.writeUInt32BE(prf, 1);
    buf.writeUInt32BE(iter, 5);
    buf.writeUInt32BE(saltLen, 9);
    // salt + subkey left as zero bytes — fine, we're testing rejection.
    return buf.toString("base64");
  }

  test("rejects PRF > 2", () => {
    expect(verifyDotnetIdentityV3(craftHash(3, 10000, 16, 32), "pw")).toBe(false);
  });

  test("rejects iter < 1", () => {
    expect(verifyDotnetIdentityV3(craftHash(1, 0, 16, 32), "pw")).toBe(false);
  });

  test("rejects iter > 5_000_000 (DoS guard)", () => {
    expect(verifyDotnetIdentityV3(craftHash(1, 5_000_001, 16, 32), "pw")).toBe(false);
  });

  test("rejects saltLen < 8", () => {
    expect(verifyDotnetIdentityV3(craftHash(1, 10000, 7, 32), "pw")).toBe(false);
  });

  test("rejects saltLen > 1024", () => {
    expect(verifyDotnetIdentityV3(craftHash(1, 10000, 1025, 32), "pw")).toBe(false);
  });

  test("rejects buffer too short to contain a subkey", () => {
    // 13-byte header claims saltLen=16, but the buffer ends right after the salt.
    const buf = Buffer.alloc(13 + 16);
    buf[0] = 0x01;
    buf.writeUInt32BE(1, 1);
    buf.writeUInt32BE(10000, 5);
    buf.writeUInt32BE(16, 9);
    expect(verifyDotnetIdentityV3(buf.toString("base64"), "pw")).toBe(false);
  });

  test("rejects buffer too short for the 13-byte header", () => {
    expect(verifyDotnetIdentityV3(Buffer.alloc(12, 0x01).toString("base64"), "pw")).toBe(false);
  });

  test("rejects bad format marker (not 0x01)", () => {
    const buf = Buffer.alloc(13 + 16 + 32);
    buf[0] = 0x02;
    buf.writeUInt32BE(1, 1);
    buf.writeUInt32BE(10000, 5);
    buf.writeUInt32BE(16, 9);
    expect(verifyDotnetIdentityV3(buf.toString("base64"), "pw")).toBe(false);
  });

  test("rejects empty input", () => {
    expect(verifyDotnetIdentityV3("", "pw")).toBe(false);
  });
});
