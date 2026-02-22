import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types/context.ts";

export const adminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "administrator") {
    return c.json({ message: "Forbidden" }, 403);
  }
  return next();
});
