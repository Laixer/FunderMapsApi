import { Hono } from "hono";
import { eq, gt, and, desc } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { session } from "../../db/schema/application.ts";
import { paginationSchema } from "../../lib/pagination.ts";
import { NotFoundError } from "../../lib/errors.ts";
import type { AppEnv } from "../../types/context.ts";

// Don't expose the bearer token — anyone reading admin logs would see it.
type SessionRow = typeof session.$inferSelect;
function toLegacySession(s: SessionRow) {
  return {
    id: s.id,
    user_id: s.userId,
    ip_address: s.ipAddress ?? null,
    user_agent: s.userAgent ?? null,
    expires_at: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
    created_at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
    updated_at: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
  };
}

const sessions = new Hono<AppEnv>();

// GET /api/management/session
//   ?user_id=<uuid>  filter to one user
//   ?include_expired=true  include sessions whose expires_at is past
sessions.get("/", async (c) => {
  const { limit, offset } = paginationSchema.parse(c.req.query());
  const userIdFilter = c.req.query("user_id");
  const includeExpired = c.req.query("include_expired") === "true";

  const conditions = [];
  if (userIdFilter) conditions.push(eq(session.userId, userIdFilter));
  if (!includeExpired) conditions.push(gt(session.expiresAt, new Date()));

  const rows = await db
    .select()
    .from(session)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(session.updatedAt))
    .limit(limit)
    .offset(offset);

  return c.json(rows.map(toLegacySession));
});

// DELETE /api/management/session/:session_id
//   Force-logout a session. The bearer token becomes 401 immediately.
sessions.delete("/:session_id", async (c) => {
  const sessionId = c.req.param("session_id");
  const deleted = await db
    .delete(session)
    .where(eq(session.id, sessionId))
    .returning({ id: session.id });
  if (deleted.length === 0) throw new NotFoundError("Session not found");
  return c.body(null, 204);
});

export default sessions;
