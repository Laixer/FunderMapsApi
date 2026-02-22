import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config.ts";
import * as schema from "./schema/index.ts";

const client = postgres(env.DATABASE_URL);

export const db = drizzle(client, { schema });
export type Database = typeof db;
