import { describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { clientIp, requireHuman, Throttle } from "./public-guards.ts";
import { AppError } from "./errors.ts";

const ctx = (headers: Record<string, string>) =>
  ({ req: { header: (n: string) => headers[n.toLowerCase()] } }) as unknown as Context;
const status = async (p: Promise<unknown>) => {
  try { await p; return 200; } catch (e) { return e instanceof AppError ? e.statusCode : -1; }
};

describe("clientIp", () => {
  test("the edge's do-connecting-ip wins over anything forwarded", () => {
    const h = { "do-connecting-ip": "1.1.1.1", "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3, 4.4.4.4" } as Record<string, string>;
    expect(clientIp((n) => h[n])).toBe("1.1.1.1");
  });
  test("then x-real-ip, then the first forwarded hop, then one shared key", () => {
    expect(clientIp((n) => ({ "x-real-ip": "2.2.2.2" } as Record<string, string>)[n])).toBe("2.2.2.2");
    expect(clientIp((n) => ({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" } as Record<string, string>)[n])).toBe("3.3.3.3");
    expect(clientIp(() => undefined)).toBe("unknown");
  });
});

describe("Throttle", () => {
  test("the limit per address within the window, then free again", () => {
    const t = new Throttle(2, 60_000);
    expect([t.allow("a", 0), t.allow("a", 1), t.allow("a", 2)]).toEqual([true, true, false]);
    expect(t.allow("b", 3)).toBe(true); // another address has its own window
    expect(t.allow("a", 60_003)).toBe(true); // the window moved on
  });
});

describe("requireHuman (Turnstile)", () => {
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  test("off without a secret", async () => {
    expect(await status(requireHuman(ctx({}), ok({ success: false }), undefined))).toBe(200);
  });
  test("no token: 403, before asking Cloudflare", async () => {
    let asked = false;
    const f = (async () => { asked = true; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await status(requireHuman(ctx({}), f, "s"))).toBe(403);
    expect(asked).toBe(false);
  });
  test("Cloudflare says yes / no", async () => {
    expect(await status(requireHuman(ctx({ "x-turnstile-token": "t" }), ok({ success: true }), "s"))).toBe(200);
    expect(await status(requireHuman(ctx({ "x-turnstile-token": "t" }), ok({ success: false, "error-codes": ["x"] }), "s"))).toBe(403);
  });
  test("Cloudflare unreachable: 503, not waved through", async () => {
    const down = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await status(requireHuman(ctx({ "x-turnstile-token": "t" }), down, "s"))).toBe(503);
  });
  test("the token, the secret and the caller's address go to Cloudflare", async () => {
    let sent = "";
    const f = (async (_u: unknown, init: RequestInit) => { sent = String(init.body); return new Response('{"success":true}'); }) as unknown as typeof fetch;
    await requireHuman(ctx({ "x-turnstile-token": "tok", "do-connecting-ip": "9.9.9.9" }), f, "sec");
    expect(new URLSearchParams(sent).get("response")).toBe("tok");
    expect(new URLSearchParams(sent).get("secret")).toBe("sec");
    expect(new URLSearchParams(sent).get("remoteip")).toBe("9.9.9.9");
  });
});
