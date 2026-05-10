import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { recovery, recoverySample } from "../db/schema/report.ts";
import { attribution } from "../db/schema/application.ts";
import { assertCanWrite } from "../lib/auth-helpers.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import { intToEnum, intsToEnums } from "../lib/inquiry-enums.ts";
import { toLegacyRecoverySample } from "../lib/recovery-serializer.ts";
import { activeOrgId, loadRecoveryScoped, requireWritable } from "./recovery.ts";
import type { AppEnv } from "../types/context.ts";

const samples = new Hono<AppEnv>();

function recoveryId(c: Context<AppEnv>): number {
  const id = parseInt(c.req.param("recovery_id"));
  if (isNaN(id)) throw new NotFoundError("Recovery not found");
  return id;
}

async function loadSampleScoped(sampleId: number, recId: number, orgId: string) {
  const [hit] = await db
    .select({ s: recoverySample })
    .from(recoverySample)
    .innerJoin(recovery, eq(recovery.id, recoverySample.recovery))
    .innerJoin(attribution, eq(attribution.id, recovery.attribution))
    .where(
      and(
        eq(recoverySample.id, sampleId),
        eq(recoverySample.recovery, recId),
        eq(attribution.owner, orgId),
      ),
    )
    .limit(1);
  if (!hit) throw new NotFoundError("Recovery sample not found");
  return hit.s;
}

// ─────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────

samples.get("/", async (c) => {
  const orgId = activeOrgId(c);
  const recId = recoveryId(c);
  await loadRecoveryScoped(recId, orgId);

  const limit = parseInt(c.req.query("limit") ?? "100");
  const offset = parseInt(c.req.query("offset") ?? "0");

  const rows = await db
    .select()
    .from(recoverySample)
    .where(eq(recoverySample.recovery, recId))
    .orderBy(recoverySample.id)
    .limit(limit)
    .offset(offset);

  return c.json(rows.map(toLegacyRecoverySample));
});

samples.get("/stats", async (c) => {
  const orgId = activeOrgId(c);
  const recId = recoveryId(c);
  await loadRecoveryScoped(recId, orgId);

  const [stat] = await db
    .select({ value: count() })
    .from(recoverySample)
    .where(eq(recoverySample.recovery, recId));
  return c.json({ count: Number(stat?.value ?? 0) });
});

samples.get("/:sid{[0-9]+}", async (c) => {
  const orgId = activeOrgId(c);
  const recId = recoveryId(c);
  const sid = parseInt(c.req.param("sid"));
  const row = await loadSampleScoped(sid, recId, orgId);
  return c.json(toLegacyRecoverySample(row));
});

// ─────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────

// `address` is the input identifier (gfm-* / BAG NUMMERAANDUIDING / BAG PAND).
// It's resolved to a building_id (BAG PAND) server-side. recovery_sample only
// stores building_id (no per-address row), unlike inquiry_sample.
const sampleBodySchema = z.object({
  address: z.string(),
  note: z.string().nullish(),
  status: z.number().int().nullish(),
  type: z.number().int(),
  pileType: z.number().int().nullish(),
  facade: z.array(z.number().int()).nullish(),
  permit: z.string().nullish(),
  permitDate: z.string().nullish(),
  recoveryDate: z.string().nullish(),
  contractor: z.number().int().nullish(),
});

type SampleInput = z.infer<typeof sampleBodySchema>;

async function resolveBuildingId(input: string): Promise<string> {
  const cleaned = input.replaceAll(" ", "").toUpperCase();
  const rows = await db.execute(sql`
    SELECT a.building_id
    FROM geocoder.address a
    WHERE a.id = ${input}
       OR a.external_id = ${cleaned}
       OR a.building_id = ${cleaned}
    LIMIT 1
  `);
  if (rows.length === 0) {
    throw new ValidationError([`Address not found: ${input}`]);
  }
  return (rows[0] as { building_id: string }).building_id;
}

function toDbValues(input: SampleInput, recId: number, buildingId: string) {
  return {
    recovery: recId,
    buildingId,
    note: input.note?.trim() || null,
    status: intToEnum("recovery_status", input.status),
    type: intToEnum("recovery_type", input.type)!,
    pileType: intToEnum("pile_type", input.pileType),
    facade: intsToEnums("facade", input.facade ?? null),
    permit: input.permit?.trim() || null,
    permitDate: input.permitDate || null,
    recoveryDate: input.recoveryDate || null,
    contractor: input.contractor ?? null,
  };
}

samples.post("/", zValidator("json", sampleBodySchema), async (c) => {
  const orgId = activeOrgId(c);
  const recId = recoveryId(c);
  const u = c.get("user");
  await assertCanWrite(u.id, orgId);

  const { row: parent } = await loadRecoveryScoped(recId, orgId);
  requireWritable(parent);

  const data = c.req.valid("json");
  const buildingId = await resolveBuildingId(data.address);

  const created = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(recoverySample)
      .values(toDbValues(data, recId, buildingId))
      .returning();
    await tx
      .update(recovery)
      .set({ auditStatus: "pending" })
      .where(eq(recovery.id, recId));
    return s!;
  });

  return c.json(toLegacyRecoverySample(created));
});

samples.put("/:sid{[0-9]+}", zValidator("json", sampleBodySchema), async (c) => {
  const orgId = activeOrgId(c);
  const recId = recoveryId(c);
  const sid = parseInt(c.req.param("sid"));
  const u = c.get("user");
  await assertCanWrite(u.id, orgId);

  const { row: parent } = await loadRecoveryScoped(recId, orgId);
  requireWritable(parent);
  await loadSampleScoped(sid, recId, orgId);

  const data = c.req.valid("json");
  const buildingId = await resolveBuildingId(data.address);

  await db.transaction(async (tx) => {
    await tx
      .update(recoverySample)
      .set({ ...toDbValues(data, recId, buildingId), updateDate: new Date() })
      .where(eq(recoverySample.id, sid));
    await tx
      .update(recovery)
      .set({ auditStatus: "pending" })
      .where(eq(recovery.id, recId));
  });

  return c.body(null, 204);
});

samples.delete("/:sid{[0-9]+}", async (c) => {
  const orgId = activeOrgId(c);
  const recId = recoveryId(c);
  const sid = parseInt(c.req.param("sid"));
  const u = c.get("user");
  await assertCanWrite(u.id, orgId);

  const { row: parent } = await loadRecoveryScoped(recId, orgId);
  requireWritable(parent);
  await loadSampleScoped(sid, recId, orgId);

  await db.transaction(async (tx) => {
    await tx.delete(recoverySample).where(eq(recoverySample.id, sid));
    const [c2] = await tx
      .select({ remaining: count() })
      .from(recoverySample)
      .where(eq(recoverySample.recovery, recId));
    if (Number(c2?.remaining ?? 0) === 0 && parent.auditStatus === "pending") {
      await tx
        .update(recovery)
        .set({ auditStatus: "todo" })
        .where(eq(recovery.id, recId));
    }
  });

  return c.body(null, 204);
});

export default samples;
