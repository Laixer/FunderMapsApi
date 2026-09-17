import { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dossier, dossierAddress, dossierEntry, artifact, extraction, extractionField, verdict } from "../db/schema/dataops.ts";
import { addEntry } from "../lib/dossier-entries.ts";
import { findAddress, loadDossierAddresses, type AddressInfo } from "../lib/dossier-addresses.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * The addresses of a dossier (ClientApp #333 part C).
 *
 * A funderingsonderzoek is about a block; a melding is filed under one house.
 * The pipeline reads the addresses a report names and resolves them where it
 * can, and until now that was the end of it: nothing on the review screen
 * could say "this address is not part of this dossier", add the one the
 * pipeline missed, or move a value from Molenwal 59 to 59A. So a report about
 * eight houses became a rapportage about one, and the other seven went into
 * the note as text (API #167).
 *
 * Four reviewer actions, all on the dossier, all before the commit:
 *
 *   verdict   confirm or reject an address. Don's ruling (2026-09-11):
 *             "adres afkeuren" means the address does not belong to this
 *             dossier, not that its values are wrong. Rejecting supersedes
 *             the open values under it; they can come back if the reviewer
 *             changes their mind (the ids are kept on the timeline entry).
 *   add       an address the document names but the pipeline did not find.
 *             Confirmed at once: a person typed it. It gets a sample on
 *             commit even with no values, to be filled in by hand.
 *   relink    move values to another address: the pipeline matched 59 where
 *             the report says 59A, or could not resolve the text at all.
 *   building  correct the pand the dossier was filed under.
 *
 * Every call answers with the refreshed list, so the Studio never has to
 * reload the dossier to see what it just did.
 */
const routes = new Hono<AppEnv>();

/**
 * Where a helper runs its statements: the pool, or the transaction it is
 * called from. Every helper that a `db.transaction` block calls must take
 * the `tx`; on the global `db` its statements run on a second pooled
 * connection and commit on their own, whatever the block decides.
 */
type Executor = Pick<typeof db, "insert" | "select">;

function dossierId(raw: string): number {
  const id = Number(raw);
  if (!Number.isFinite(id)) throw new ValidationError(["dossier id must be a number"]);
  return id;
}

async function openDossier(id: number) {
  const [head] = await db.select().from(dossier).where(eq(dossier.id, id)).limit(1);
  if (!head) throw new NotFoundError("dossier not found");
  if (head.inquiryId) throw new ValidationError([`dossier already committed as inquiry ${head.inquiryId}`]);
  if (head.outcome) throw new ValidationError([`dossier closed as ${head.outcome}`]);
  return head;
}

/** Insert or update the row for (dossier, address). `source` only applies on insert. */
async function upsertAddress(
  id: number,
  a: AddressInfo,
  patch: { state: "pending" | "confirmed" | "rejected"; note?: string | null; addressText?: string | null; source: "pipeline" | "reviewer" },
  userId: string,
  on: Executor = db,
) {
  const decided = patch.state === "pending" ? { decidedBy: null, decidedAt: null } : { decidedBy: userId, decidedAt: new Date() };
  await on
    .insert(dossierAddress)
    .values({
      dossierId: id,
      addressId: a.id,
      addressText: patch.addressText ?? null,
      source: patch.source,
      state: patch.state,
      note: patch.note ?? null,
      ...decided,
    })
    .onConflictDoUpdate({
      target: [dossierAddress.dossierId, dossierAddress.addressId],
      set: {
        state: patch.state,
        note: patch.note ?? null,
        ...decided,
        // Keep the text the document wrote; fill it only when there was none.
        addressText: sql`coalesce(${dossierAddress.addressText}, ${patch.addressText ?? null})`,
      },
    });
}

/** Whether the pipeline put values under this address on this dossier. */
async function pipelineKnows(id: number, addressId: string, on: Executor = db): Promise<boolean> {
  const [r] = await on
    .select({ n: sql<number>`count(*)::int` })
    .from(extractionField)
    .innerJoin(extraction, eq(extraction.id, extractionField.extractionId))
    .innerJoin(artifact, eq(artifact.id, extraction.artifactId))
    .where(and(eq(artifact.dossierId, id), eq(extractionField.addressId, addressId)));
  return (r?.n ?? 0) > 0;
}

/**
 * Confirm or reject an address, or take a decision back (`pending`).
 *
 * `addressId` for a resolved address; `addressText` alone for one the Worker
 * could not resolve -- that one can only be rejected (or re-linked, which is
 * the other endpoint), because there is no row to confirm.
 */
routes.post("/dossier/:id/address/verdict", async (c) => {
  const id = dossierId(c.req.param("id"));
  const u = c.get("user");
  const body = await c.req.json<{ addressId?: string; addressText?: string; outcome: "confirmed" | "rejected" | "pending"; note?: string | null }>();
  if (!["confirmed", "rejected", "pending"].includes(body.outcome)) {
    throw new ValidationError(["outcome must be confirmed, rejected or pending"]);
  }
  const note = body.note?.trim() || null;
  const head = await openDossier(id);

  const text = body.addressText?.trim() || null;
  const a = body.addressId ? await findAddress(body.addressId) : null;
  if (!a && !text) throw new ValidationError(["addressId or addressText is required"]);
  if (!a && body.outcome === "confirmed") {
    throw new ValidationError(["an unresolved address cannot be confirmed; link it to an address first"]);
  }
  if (a && a.buildingId && a.buildingId === head.buildingId && body.outcome === "rejected") {
    throw new ValidationError(["this is the dossier's own pand; change the pand instead of rejecting it"]);
  }

  // Which values sit under this address: by id, or by the text when unresolved.
  // Raw fragments on the alias `f`: a drizzle column inside the aliased UPDATE
  // would render as "dataops"."extraction_field"."address_id" and not resolve.
  const under = a
    ? sql`f.address_id = ${a.id}`
    : sql`f.address_id is null and f.address_text = ${text}`;

  if (body.outcome === "rejected") {
    // Only values nobody judged: a verdict is a decision taken, and the
    // commit skips the address anyway. The ids go on the entry so `pending`
    // can undo exactly this.
    const superseded = await db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: number }>(sql`
        update ${extractionField} f set state = 'superseded'
        from ${extraction} e join ${artifact} ar on ar.id = e.artifact_id
        where e.id = f.extraction_id and ar.dossier_id = ${id}
          and (${under})
          and f.state in ('pending', 'auto_accepted', 'rejected')
          and not exists (select 1 from ${verdict} v where v.extraction_field_id = f.id)
        returning f.id`);
      if (a) await upsertAddress(id, a, { state: "rejected", note, addressText: text, source: (await pipelineKnows(id, a.id, tx)) ? "pipeline" : "reviewer" }, u.id, tx);
      return rows.map((r) => Number(r.id));
    });
    await addEntry({
      dossierId: id, kind: "finding", actorKind: "reviewer", actor: u.id,
      text: `Adres afgekeurd: ${a?.label ?? text} — hoort niet bij dit dossier` + (note ? ` — ${note}` : "") + (superseded.length ? ` (${superseded.length} waarde${superseded.length === 1 ? "" : "n"} vervallen)` : ""),
      body: { address_id: a?.id ?? null, address_text: text, outcome: "rejected", superseded_ids: superseded },
      visibleToMelder: false,
    });
  } else {
    // Confirm, or take a rejection back. Values this same address's rejection
    // superseded come back as pending; anything superseded for another
    // reason (a re-read, a close) stays where it is.
    const [last] = await db
      .select({ body: dossierEntry.body })
      .from(dossierEntry)
      .where(and(
        eq(dossierEntry.dossierId, id), eq(dossierEntry.kind, "finding"),
        a ? sql`${dossierEntry.body} ->> 'address_id' in (${a.id}, ${a.legacyId})` : sql`${dossierEntry.body} ->> 'address_text' = ${text}`,
        sql`${dossierEntry.body} ->> 'outcome' = 'rejected'`,
      ))
      .orderBy(desc(dossierEntry.id))
      .limit(1);
    const ids = ((last?.body?.superseded_ids as unknown[] | undefined) ?? []).map(Number).filter(Number.isFinite);
    let restored = 0;
    await db.transaction(async (tx) => {
      if (ids.length) {
        const r = await tx.update(extractionField).set({ state: "pending" })
          .where(and(inArray(extractionField.id, ids), eq(extractionField.state, "superseded")))
          .returning({ id: extractionField.id });
        restored = r.length;
      }
      if (a) await upsertAddress(id, a, { state: body.outcome, note, addressText: text, source: (await pipelineKnows(id, a.id, tx)) ? "pipeline" : "reviewer" }, u.id, tx);
    });
    await addEntry({
      dossierId: id, kind: "finding", actorKind: "reviewer", actor: u.id,
      text: (body.outcome === "confirmed" ? `Adres bevestigd: ${a!.label}` : `Beslissing over adres teruggenomen: ${a?.label ?? text}`) + (note ? ` — ${note}` : "") + (restored ? ` (${restored} waarde${restored === 1 ? "" : "n"} weer open)` : ""),
      body: { address_id: a?.id ?? null, address_text: text, outcome: body.outcome, restored_ids: ids.slice(0, restored) },
      visibleToMelder: false,
    });
  }

  return c.json({ ok: true, addresses: await loadDossierAddresses(id) });
});

/** An address the document names but the pipeline did not find. Confirmed at once. */
routes.post("/dossier/:id/address", async (c) => {
  const id = dossierId(c.req.param("id"));
  const u = c.get("user");
  const body = await c.req.json<{ addressId: string; note?: string | null }>();
  await openDossier(id);
  const a = await findAddress(body.addressId);
  await upsertAddress(id, a, { state: "confirmed", note: body.note?.trim() || null, source: "reviewer" }, u.id);
  await addEntry({
    dossierId: id, kind: "finding", actorKind: "reviewer", actor: u.id,
    text: `Adres toegevoegd: ${a.label}` + (body.note?.trim() ? ` — ${body.note.trim()}` : ""),
    body: { address_id: a.id, outcome: "confirmed", added: true },
    visibleToMelder: false,
  });
  return c.json({ ok: true, addresses: await loadDossierAddresses(id) });
});

/**
 * Move values to another address. Selection: explicit `fieldIds`, or every
 * value under `addressId` / unresolved `addressText`. The target becomes a
 * confirmed address of the dossier if it was not one yet.
 */
routes.post("/dossier/:id/address/relink", async (c) => {
  const id = dossierId(c.req.param("id"));
  const u = c.get("user");
  const body = await c.req.json<{ to: string; fieldIds?: number[]; addressId?: string; addressText?: string }>();
  await openDossier(id);
  const target = await findAddress(body.to);

  const fieldIds = (body.fieldIds ?? []).filter((n) => Number.isInteger(n));
  const fromText = body.addressText?.trim() || null;
  const where = fieldIds.length
    ? sql`f.id in ${fieldIds}`
    : body.addressId
      ? sql`f.address_id = ${body.addressId}`
      : fromText
        ? sql`f.address_id is null and f.address_text = ${fromText}`
        : null;
  if (!where) throw new ValidationError(["fieldIds, addressId or addressText is required"]);

  const moved = await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: number }>(sql`
      update ${extractionField} f set address_id = ${target.id}
      from ${extraction} e join ${artifact} ar on ar.id = e.artifact_id
      where e.id = f.extraction_id and ar.dossier_id = ${id}
        and (${where})
        and f.state <> 'superseded'
        and (f.address_id is distinct from ${target.id})
      returning f.id`);
    // Make it a confirmed address of the dossier; a rejected row is turned
    // around, since the reviewer just put values on it on purpose.
    await tx
      .insert(dossierAddress)
      .values({ dossierId: id, addressId: target.id, addressText: fromText, source: "reviewer", state: "confirmed", decidedBy: u.id, decidedAt: new Date() })
      .onConflictDoUpdate({
        target: [dossierAddress.dossierId, dossierAddress.addressId],
        set: { state: "confirmed", decidedBy: u.id, decidedAt: new Date(), addressText: sql`coalesce(${dossierAddress.addressText}, ${fromText})` },
      });
    return rows.map((r) => Number(r.id));
  });

  const from = body.addressId ? (await findAddress(body.addressId).catch(() => null))?.label ?? body.addressId : fromText;
  await addEntry({
    dossierId: id, kind: "finding", actorKind: "reviewer", actor: u.id,
    text: `${moved.length} waarde${moved.length === 1 ? "" : "n"} gekoppeld aan ${target.label}` + (from ? ` (was: ${from})` : ""),
    body: { address_id: target.id, from_address_id: body.addressId ?? null, from_address_text: fromText, field_ids: moved, outcome: "relinked" },
    visibleToMelder: false,
  });
  return c.json({ ok: true, moved: moved.length, addresses: await loadDossierAddresses(id) });
});

/** Correct the pand the dossier was filed under. */
routes.post("/dossier/:id/building", async (c) => {
  const id = dossierId(c.req.param("id"));
  const u = c.get("user");
  const body = await c.req.json<{ addressId: string }>();
  const head = await openDossier(id);
  const a = await findAddress(body.addressId);
  if (!a.buildingId) throw new ValidationError([`address ${a.label} has no pand`]);
  await db.update(dossier).set({ buildingId: a.buildingId, resolutionStatus: "resolved" }).where(eq(dossier.id, id));
  await addEntry({
    dossierId: id, kind: "status", actorKind: "reviewer", actor: u.id,
    text: `Pand aangepast: ${a.label}` + (head.buildingId ? "" : " (had geen pand)"),
    body: { building_id: a.buildingId, previous_building_id: head.buildingId, address_id: a.id },
    visibleToMelder: false,
  });
  return c.json({ ok: true, addresses: await loadDossierAddresses(id, { buildingId: a.buildingId }) });
});

export default routes;
