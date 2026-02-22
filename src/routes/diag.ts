import { Hono } from "hono";

const diag = new Hono();

diag.get("/ip", (c) => {
  const ip =
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    c.req.header("X-Real-IP") ??
    "unknown";
  return c.json({ ip });
});

diag.get("/req", (c) => {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return c.json(headers);
});

export default diag;
