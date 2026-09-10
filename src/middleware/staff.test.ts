import { describe, test, expect } from "bun:test";
import { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { staffMiddleware } = await import("./staff.ts");
const { env } = await import("../config.ts");
type AppEnv = import("../types/context.ts").AppEnv;

// Builds an app where the auth middleware is replaced by a stub that injects
// the given memberships, so only the staff gate is under test.
function appFor(organizations: { id: string }[]) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "u1", organizations } as AppEnv["Variables"]["user"]);
    await next();
  });
  app.use("/api/dataops/*", staffMiddleware);
  app.get("/api/dataops/queue", (c) => c.json({ ok: true }));
  return app;
}

describe("staffMiddleware", () => {
  test("platform-org member passes", async () => {
    const res = await appFor([{ id: env.PLATFORM_ORGANIZATION_ID }]).request(
      "/api/dataops/queue",
    );
    expect(res.status).toBe(200);
  });

  test("customer-org member is refused with 403", async () => {
    const res = await appFor([
      { id: "11111111-1111-1111-1111-111111111111" },
    ]).request("/api/dataops/queue");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "Forbidden" });
  });

  test("user without any organisation is refused", async () => {
    const res = await appFor([]).request("/api/dataops/queue");
    expect(res.status).toBe(403);
  });
});
