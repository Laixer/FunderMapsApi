import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { buildInquirySearchPredicate } from "../lib/inquiry-search.ts";

const render = (q: string) => new PgDialect().sqlToQuery(buildInquirySearchPredicate(q));

/**
 * One column per kind of input, and never a text scan over id columns.
 * Until 2026-09-17 every free-text search ran ILIKE over inquiry_sample.address
 * and .building_id (which hold ids, so a word can never match) joined to the
 * 10.8M-row address table: 6–35 s per search.
 */
describe("inquiry search predicate", () => {
  test("a plain int is an id lookup and nothing else", () => {
    const { sql, params } = render("158274");
    expect(sql).toMatch(/"report"\."inquiry"\."id" = \$1/);
    expect(sql).not.toMatch(/ilike/i);
    expect(params).toEqual([158274]);
  });

  test("a BAG pand id matches the sample's building_id exactly", () => {
    const { sql, params } = render("NL.IMBAG.PAND.0632100000033693");
    expect(sql).toMatch(/"report"\."inquiry_sample"\."building_id" = \$1/);
    expect(sql).not.toMatch(/ilike/i);
    expect(sql).not.toMatch(/geocoder/);
    expect(params).toEqual(["NL.IMBAG.PAND.0632100000033693"]);
  });

  test("a nummeraanduiding resolves through geocoder.address.external_id, then the sample's address", () => {
    const { sql, params } = render("nl.imbag.nummeraanduiding.0632200010095517");
    expect(sql).toMatch(/"geocoder"\."address"\."external_id" = \$1/);
    expect(sql).toMatch(/"report"\."inquiry_sample"\."address" in \(select/);
    expect(sql).not.toMatch(/ilike/i);
    expect(params).toEqual(["NL.IMBAG.NUMMERAANDUIDING.0632200010095517"]);
  });

  test("a gfm- address id (echoed) matches the sample's address in either spelling, never by text scan", () => {
    const { sql } = render("gfm-8fe68992a9d54deca778df1234567890");
    expect(sql).toMatch(/"report"\."inquiry_sample"\."address" = \$1/);
    expect(sql).toMatch(/"geocoder"\."address"\."id" = \$2/);
    expect(sql).not.toMatch(/ilike/i);
  });

  test("a bare BAG number is tried as pand and as nummeraanduiding, both exact", () => {
    const { sql, params } = render("0632100000033693");
    expect(sql).not.toMatch(/ilike/i);
    expect(params).toEqual(["NL.IMBAG.PAND.0632100000033693", "NL.IMBAG.NUMMERAANDUIDING.0632100000033693"]);
  });

  test("free text only touches document_name", () => {
    const { sql, params } = render("kerkstraat");
    expect(sql).toMatch(/"report"\."inquiry"\."document_name" ilike \$1/);
    expect(sql).not.toMatch(/inquiry_sample/);
    expect(sql).not.toMatch(/geocoder/);
    expect(params).toEqual(["%kerkstraat%"]);
  });
});
