import { Hono } from "hono";
import { asc } from "drizzle-orm";
import { db } from "../db/client.ts";
import { contractor } from "../db/schema/application.ts";

const contractors = new Hono();

contractors.get("/", async (c) => {
  const rows = await db.select().from(contractor).orderBy(asc(contractor.id));
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(rows);
});

export default contractors;
