import { describe, test, expect } from "bun:test";

// Pin the security-relevant Better Auth options so a refactor or a Better
// Auth upgrade can't drop them silently: disabled self sign-up, the client-IP
// header behind the DO edge, and a rate limiter that doesn't depend on
// NODE_ENV. None of this opens a connection.
process.env.DATABASE_URL ??= "postgres://test@localhost:5432/test";
process.env.APP_ID ??= "ci-test-app";
process.env.AUTH_SECRET ??= "ci-test-secret-not-used-for-anything-real";
process.env.BASE_URL ??= "http://localhost:3000";

const { auth } = await import("./auth");

describe("Better Auth security options", () => {
  test("rate limiting is on regardless of NODE_ENV", () => {
    expect(auth.options.rateLimit?.enabled).toBe(true);
  });

  test("self sign-up stays disabled", () => {
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
  });

  test("client IP comes from the edge-overwritten header only", () => {
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([
      "do-connecting-ip",
    ]);
  });

  test("a 4th sign-in attempt from one IP within 10 s gets 429", async () => {
    // A path under /sign-in that no endpoint serves: the limiter runs before
    // routing, so this exercises the real limiter without touching the DB.
    const attempt = (ip: string) =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/rate-limit-probe", {
          method: "POST",
          headers: { "content-type": "application/json", "do-connecting-ip": ip },
          body: "{}",
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await attempt("203.0.113.7")).status);
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses[3]).toBe(429);
    // Another client is not affected by the first one's budget.
    expect((await attempt("203.0.113.8")).status).not.toBe(429);
  });
});
