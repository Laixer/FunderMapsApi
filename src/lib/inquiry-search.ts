import { and, eq, exists, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { inquiry, inquirySample } from "../db/schema/report.ts";
import { address as geocoderAddress } from "../db/schema/geocoder.ts";
import { fromIdentifier, GeocoderDatasource } from "./geocoder-id.ts";

// Search across id (numeric exact), document_name, and the sample's address
// or pand identifiers.
//
// One predicate per kind of input, each on an index:
//
//   plain int                     inquiry.id
//   NL.IMBAG.PAND.*               inquiry_sample.building_id (exact)
//   NL.IMBAG.NUMMERAANDUIDING.*   geocoder.address.external_id → inquiry_sample.address
//   gfm-*                         inquiry_sample.address (exact, or via address.id → external_id; echoed ids only)
//   bare BAG number (≥ 10 digits) both of the above with the prefix added
//   anything else                 inquiry.document_name ILIKE
//
// Until 2026-09-17 every free-text search also ran `ILIKE '%q%'` over the
// sample's `address` and `building_id` columns joined to geocoder.address.
// Those columns hold ids (100 % gfm- / NL.IMBAG.PAND.*), so a word can never
// match them, yet the planner had to walk every sample of every inquiry and
// probe the 10.8M-row address table per sample: 499,109 index probes and
// 6–35 s per search, both here and in `/stats`. The same search now costs
// tens of milliseconds. What is gone with it: matching a *fragment* of an id
// ("0632100000" for a pand). That needs pg_trgm, which is not installed;
// full ids match exactly.
export function buildInquirySearchPredicate(q: string): SQL {
  const qb = new QueryBuilder();
  // BAG identifiers contain long digit runs (e.g. "0202100000216966") that
  // overflow int32 — only treat as an ID match when it fits.
  const asInt = /^\d+$/.test(q) ? Number(q) : NaN;
  const numericId = Number.isSafeInteger(asInt) && asInt <= 2147483647 ? asInt : null;

  // Fast path for an exact id lookup. Keeping the text predicates in the
  // same OR clause caused the planner to fall off the PK index and scan
  // the whole org (13s in prod for a single-row lookup). When the user
  // types a plain int, that's an id query — short-circuit on it.
  if (numericId != null) {
    return eq(inquiry.id, numericId);
  }

  const cleaned = q.replaceAll(" ", "").toUpperCase();
  const byPand = (pandId: string) =>
    exists(
      qb
        .select({ x: sql`1` })
        .from(inquirySample)
        .where(and(eq(inquirySample.inquiry, inquiry.id), eq(inquirySample.building, pandId))),
    );
  const byNummeraanduiding = (externalId: string) =>
    exists(
      qb
        .select({ x: sql`1` })
        .from(inquirySample)
        .where(
          and(
            eq(inquirySample.inquiry, inquiry.id),
            inArray(
              inquirySample.address,
              qb.select({ id: geocoderAddress.id }).from(geocoderAddress).where(eq(geocoderAddress.externalId, externalId)),
            ),
          ),
        ),
    );

  switch (fromIdentifier(q)) {
    case GeocoderDatasource.NlBagBuilding:
      return byPand(cleaned);
    case GeocoderDatasource.NlBagAddress:
      return byNummeraanduiding(cleaned);
    case GeocoderDatasource.FunderMaps:
      // Echoed gfm- id. Samples store the nummeraanduiding since Worker #158
      // step 2; rows not yet rewritten still hold the gfm- id, so both match.
      return exists(
        qb
          .select({ x: sql`1` })
          .from(inquirySample)
          .where(
            and(
              eq(inquirySample.inquiry, inquiry.id),
              or(
                eq(inquirySample.address, q),
                inArray(inquirySample.address, qb.select({ e: geocoderAddress.externalId }).from(geocoderAddress).where(eq(geocoderAddress.id, q))),
              ),
            ),
          ),
      );
    default:
      break;
  }

  // A bare BAG number pasted without its prefix: try it as a pand and as a
  // nummeraanduiding. Both exact, both indexed.
  if (/^\d{10,16}$/.test(cleaned)) {
    return or(byPand(`NL.IMBAG.PAND.${cleaned}`), byNummeraanduiding(`NL.IMBAG.NUMMERAANDUIDING.${cleaned}`))!;
  }

  return ilike(inquiry.documentName, `%${q}%`);
}
