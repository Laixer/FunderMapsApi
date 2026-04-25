import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { NotFoundError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

const product = new Hono<AppEnv>();

product.get("/subsidence", async (c) => {
  const buildingId = c.req.param("building_id")!;

  const result = await db.execute(sql`
    SELECT building_id, velocity
    FROM data.building_subsidence
    WHERE building_id = ${buildingId}
    LIMIT 1
  `);

  if (result.length === 0)
    throw new NotFoundError("Subsidence data not found");

  return c.json(result[0]);
});

product.get("/subsidence/historic", async (c) => {
  const buildingId = c.req.param("building_id")!;

  const result = await db.execute(sql`
    SELECT building_id, velocity, mark_at
    FROM data.building_subsidence_history
    WHERE building_id = ${buildingId}
  `);

  if (result.length === 0)
    throw new NotFoundError("Historic subsidence data not found");

  return c.json(result);
});

export default product;
