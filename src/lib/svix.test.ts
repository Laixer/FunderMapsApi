import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "./svix.ts";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

function sign(id: string, timestamp: string, payload: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return (
    "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64")
  );
}

function now(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("verifyWebhookSignature", () => {
  const payload = '{"type":"email.received","data":{"email_id":"abc"}}';

  test("accepts a correctly signed request", () => {
    const ts = now();
    const sig = sign("msg_1", ts, payload);
    expect(
      verifyWebhookSignature(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, payload),
    ).toBe(true);
  });

  test("accepts when one of several signatures matches (key rotation)", () => {
    const ts = now();
    const sig = `v1,${"A".repeat(43)}= ${sign("msg_1", ts, payload)}`;
    expect(
      verifyWebhookSignature(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, payload),
    ).toBe(true);
  });

  test("rejects a tampered payload", () => {
    const ts = now();
    const sig = sign("msg_1", ts, payload);
    expect(
      verifyWebhookSignature(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, payload + " "),
    ).toBe(false);
  });

  test("rejects the wrong secret", () => {
    const ts = now();
    const sig = sign("msg_1", ts, payload, "whsec_c2VjcmV0LXRoYXQtaXMtd3Jvbmc=");
    expect(
      verifyWebhookSignature(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, payload),
    ).toBe(false);
  });

  test("rejects a stale timestamp (replay)", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const sig = sign("msg_1", ts, payload);
    expect(
      verifyWebhookSignature(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, payload),
    ).toBe(false);
  });

  test("rejects missing headers", () => {
    expect(
      verifyWebhookSignature(SECRET, { id: undefined, timestamp: now(), signature: "v1,x" }, payload),
    ).toBe(false);
  });
});
