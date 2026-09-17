import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dossier, dossierAddress, artifact, extraction, extractionField } from "../db/schema/dataops.ts";
import { address as geocoderAddress } from "../db/schema/geocoder.ts";
import { GeocoderDatasource, fromIdentifier } from "./geocoder-id.ts";
import { NotFoundError, ValidationError } from "./errors.ts";

/**
 * The addresses of a dossier (ClientApp #333 part C, points 3 and 4).
 *
 * Three things are combined into one list the reviewer can act on:
 *
 *   - the dossier's own pand: what the submission was filed under
 *     (`dossier.building_id`), shown first, never a row in dossier_address;
 *   - the addresses the pipeline found in the document: the distinct
 *     `address_text` / `address_id` pairs on its values. Part D will write
 *     these as pipeline rows at ingest; until then they are derived here, so
 *     the list is right for the 2,400 dossiers read before this existed;
 *   - the rows in `dataops.dossier_address`: the decisions (confirmed,
 *     rejected) and the addresses a reviewer added by hand.
 *
 * A row wins over a derived entry with the same address; a derived entry with
 * no row is `pending`. An address the document names but the Worker could not
 * resolve has no id and can only be rejected or re-linked.
 */

export type AddressSource = "pipeline" | "reviewer" | "melder";
export type AddressState = "pending" | "confirmed" | "rejected";

/** A geocoder.address as the review lane needs it. */
export interface AddressInfo {
  /** Internal gfm- key; still what `extraction_field` and `dossier_address` store. Goes with Worker #158. */
  id: string;
  /** BAG nummeraanduiding: the id to hand out and to accept. */
  externalId: string;
  buildingId: string | null;
  label: string;
}

export interface AddressRow {
  addressId: string;
  addressText: string | null;
  source: string;
  state: string;
  note: string | null;
  decidedAt: Date | null;
}

/** The values under one (address_id, address_text) pair on the dossier. */
export interface FieldGroup {
  addressId: string | null;
  addressText: string | null;
  /** Still waiting for a verdict. */
  open: number;
  /** Everything but superseded. */
  total: number;
  /** Put aside: by an address rejection, a re-read or a close. */
  superseded: number;
}

export interface DossierAddressView {
  /** What the Studio groups values by: the address id, or the text when unresolved. */
  key: string;
  addressId: string | null;
  /** BAG nummeraanduiding of `addressId`; the id a client should send back. */
  addressExternalId: string | null;
  buildingId: string | null;
  /** "Molenwal 15, 3421 CK Oudewater"; null when unresolved. */
  label: string | null;
  /** The address as the document wrote it. Several spellings can resolve to one address. */
  addressText: string | null;
  source: AddressSource;
  state: AddressState;
  /** The pand the dossier was filed under. */
  own: boolean;
  open: number;
  total: number;
  note: string | null;
  decidedAt: string | null;
}

export function formatAddress(a: {
  street: string | null;
  buildingNumber: string | null;
  postalCode: string | null;
  city: string | null;
}): string {
  const line = [a.street, a.buildingNumber].filter(Boolean).join(" ");
  const place = [a.postalCode, a.city].filter(Boolean).join(" ");
  return [line, place].filter(Boolean).join(", ");
}

/** Pure merge, so it can be tested without a database. */
export function mergeAddresses(input: {
  own: AddressInfo | null;
  rows: AddressRow[];
  groups: FieldGroup[];
  info: Map<string, AddressInfo>;
}): DossierAddressView[] {
  const { own, rows, groups, info } = input;
  const out = new Map<string, DossierAddressView>();

  const entry = (key: string, base: Partial<DossierAddressView> & { addressId: string | null }) => {
    const a = base.addressId ? info.get(base.addressId) : undefined;
    const v: DossierAddressView = {
      key,
      addressId: base.addressId,
      addressExternalId: a?.externalId ?? null,
      buildingId: a?.buildingId ?? null,
      label: a?.label ?? null,
      addressText: base.addressText ?? null,
      source: base.source ?? "pipeline",
      state: base.state ?? "pending",
      own: base.own ?? false,
      open: 0,
      total: 0,
      note: base.note ?? null,
      decidedAt: base.decidedAt ?? null,
    };
    out.set(key, v);
    return v;
  };

  if (own) entry(own.id, { addressId: own.id, source: "melder", state: "confirmed", own: true });

  for (const r of rows) {
    const existing = out.get(r.addressId);
    if (existing) {
      // The dossier's own pand with a decision on it: keep it first and own,
      // take the decision.
      existing.state = asState(r.state);
      existing.note = r.note;
      existing.decidedAt = r.decidedAt?.toISOString() ?? null;
      existing.addressText = existing.addressText ?? r.addressText;
      continue;
    }
    entry(r.addressId, {
      addressId: r.addressId,
      addressText: r.addressText,
      source: asSource(r.source),
      state: asState(r.state),
      note: r.note,
      decidedAt: r.decidedAt?.toISOString() ?? null,
    });
  }

  for (const g of groups) {
    if (!g.addressId && !g.addressText) continue; // document-level values are not an address
    const key = g.addressId ?? `text:${g.addressText}`;
    const v = out.get(key) ?? entry(key, { addressId: g.addressId, addressText: g.addressText, source: "pipeline" });
    if (!v.addressText && g.addressText) v.addressText = g.addressText;
    else if (g.addressText && v.addressText && v.addressText !== g.addressText && !v.addressText.includes(g.addressText)) {
      v.addressText = `${v.addressText} / ${g.addressText}`;
    }
    v.open += g.open;
    v.total += g.total;
    // An unresolved address has no row to carry a decision; when every value
    // under it was put aside, that is what the reviewer did to it.
    if (!g.addressId && v.total === 0 && g.superseded > 0) v.state = "rejected";
  }

  // Own pand first, then in the order found, rejected at the end.
  const list = [...out.values()];
  const rank = (v: DossierAddressView) => (v.own ? 0 : v.state === "rejected" ? 2 : 1);
  return list
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i)
    .map(({ v }) => v);
}

function asState(s: string): AddressState {
  return s === "confirmed" || s === "rejected" ? s : "pending";
}
function asSource(s: string): AddressSource {
  return s === "reviewer" || s === "melder" ? s : "pipeline";
}

/** geocoder.address rows for a set of ids, keyed by id. */
export async function addressInfo(ids: string[]): Promise<Map<string, AddressInfo>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db
    .select({
      id: geocoderAddress.id,
      externalId: geocoderAddress.externalId,
      buildingId: geocoderAddress.buildingId,
      street: geocoderAddress.street,
      buildingNumber: geocoderAddress.buildingNumber,
      postalCode: geocoderAddress.postalCode,
      city: geocoderAddress.city,
    })
    .from(geocoderAddress)
    .where(inArray(geocoderAddress.id, unique));
  return new Map(rows.map((r) => [r.id, { id: r.id, externalId: r.externalId, buildingId: r.buildingId, label: formatAddress(r) }]));
}

/**
 * One address by id -- a BAG nummeraanduiding (what the Studio sends since
 * 2026-09-17) or the internal `gfm-` id (echoed from rows the API handed
 * out; goes with Worker #158). Each kind is looked up in its own column.
 * A pand id is refused: a dossier address is a house, not a building.
 */
export async function findAddress(input: string): Promise<AddressInfo> {
  const raw = (input ?? "").trim();
  if (!raw) throw new ValidationError(["addressId is required"]);
  const ds = fromIdentifier(raw);
  const where =
    ds === GeocoderDatasource.FunderMaps
      ? eq(geocoderAddress.id, raw)
      : ds === GeocoderDatasource.NlBagAddress
        ? eq(geocoderAddress.externalId, raw.replaceAll(" ", "").toUpperCase())
        : null;
  if (!where) throw new ValidationError([`not an address id: ${raw}`]);
  const [r] = await db
    .select({
      id: geocoderAddress.id,
      externalId: geocoderAddress.externalId,
      buildingId: geocoderAddress.buildingId,
      street: geocoderAddress.street,
      buildingNumber: geocoderAddress.buildingNumber,
      postalCode: geocoderAddress.postalCode,
      city: geocoderAddress.city,
    })
    .from(geocoderAddress)
    .where(where)
    .limit(1);
  if (!r) throw new NotFoundError(`address not found: ${raw}`);
  return { id: r.id, externalId: r.externalId, buildingId: r.buildingId, label: formatAddress(r) };
}

/** The first address of the dossier's own pand, or null when it has none. */
export async function ownAddress(buildingId: string | null): Promise<AddressInfo | null> {
  if (!buildingId) return null;
  const [r] = await db
    .select({
      id: geocoderAddress.id,
      externalId: geocoderAddress.externalId,
      buildingId: geocoderAddress.buildingId,
      street: geocoderAddress.street,
      buildingNumber: geocoderAddress.buildingNumber,
      postalCode: geocoderAddress.postalCode,
      city: geocoderAddress.city,
    })
    .from(geocoderAddress)
    .where(eq(geocoderAddress.buildingId, buildingId))
    .orderBy(asc(geocoderAddress.buildingNumber))
    .limit(1);
  return r ? { id: r.id, externalId: r.externalId, buildingId: r.buildingId, label: formatAddress(r) } : null;
}

/** The (address_id, address_text) pairs on a dossier's values, with counts. */
export async function fieldGroups(dossierId: number): Promise<FieldGroup[]> {
  const rows = await db
    .select({
      addressId: extractionField.addressId,
      addressText: extractionField.addressText,
      open: sql<number>`count(*) filter (where ${extractionField.state} in ('pending', 'auto_accepted', 'rejected'))::int`,
      total: sql<number>`count(*) filter (where ${extractionField.state} <> 'superseded')::int`,
      superseded: sql<number>`count(*) filter (where ${extractionField.state} = 'superseded')::int`,
      first: sql<number>`min(${extractionField.id})`,
    })
    .from(extractionField)
    .innerJoin(extraction, eq(extraction.id, extractionField.extractionId))
    .innerJoin(artifact, eq(artifact.id, extraction.artifactId))
    .where(and(eq(artifact.dossierId, dossierId), or(isNotNull(extractionField.addressId), isNotNull(extractionField.addressText))))
    .groupBy(extractionField.addressId, extractionField.addressText)
    .orderBy(sql`min(${extractionField.id})`);
  return rows.map((r) => ({ addressId: r.addressId, addressText: r.addressText, open: r.open, total: r.total, superseded: r.superseded }));
}

/** The full list for one dossier. `head` saves a query when the caller has it. */
export async function loadDossierAddresses(
  dossierId: number,
  head?: { buildingId: string | null },
): Promise<DossierAddressView[]> {
  const h = head ?? (await db.select({ buildingId: dossier.buildingId }).from(dossier).where(eq(dossier.id, dossierId)).limit(1))[0];
  if (!h) throw new NotFoundError("dossier not found");
  const [own, rows, groups] = await Promise.all([
    ownAddress(h.buildingId),
    db
      .select({
        addressId: dossierAddress.addressId,
        addressText: dossierAddress.addressText,
        source: dossierAddress.source,
        state: dossierAddress.state,
        note: dossierAddress.note,
        decidedAt: dossierAddress.decidedAt,
      })
      .from(dossierAddress)
      .where(eq(dossierAddress.dossierId, dossierId))
      .orderBy(asc(dossierAddress.id)),
    fieldGroups(dossierId),
  ]);
  const ids = [...rows.map((r) => r.addressId), ...groups.map((g) => g.addressId).filter((x): x is string => !!x)];
  const info = await addressInfo(ids);
  if (own) info.set(own.id, own);
  return mergeAddresses({ own, rows, groups, info });
}

/**
 * The decisions the commit needs: which addresses are out, which are in even
 * without a value. Keyed by address id.
 */
export async function addressDecisions(dossierId: number): Promise<Map<string, AddressState>> {
  const rows = await db
    .select({ addressId: dossierAddress.addressId, state: dossierAddress.state })
    .from(dossierAddress)
    .where(eq(dossierAddress.dossierId, dossierId));
  return new Map(rows.map((r) => [r.addressId, asState(r.state)]));
}
