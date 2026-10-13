import { describe, expect, test } from "bun:test";
import { meldingRows } from "./incident-meldingen.ts";

const PAND = "NL.IMBAG.PAND.0000000000000001";

describe("meldingRows", () => {
  test("one row per melding, in the order given", () => {
    expect(meldingRows(PAND, ["Het funderingstype klopt niet", "Overig"])).toEqual([
      { kind: "melding", id: `melding-1-${PAND}`, building_id: PAND, topic: "Het funderingstype klopt niet" },
      { kind: "melding", id: `melding-2-${PAND}`, building_id: PAND, topic: "Overig" },
    ]);
  });
  test("a row carries the pand and the topic and nothing else", () => {
    const [row] = meldingRows(PAND, ["Overig"]);
    expect(Object.keys(row!).sort()).toEqual(["building_id", "id", "kind", "topic"]);
  });
  test("ids are unique across panden", () => {
    const other = "NL.IMBAG.PAND.0000000000000002";
    expect(meldingRows(PAND, ["a"])[0]!.id).not.toBe(meldingRows(other, ["a"])[0]!.id);
  });
  test("a melding without a topic is not a row", () => {
    expect(meldingRows(PAND, [null, "", "  ", undefined])).toEqual([]);
    expect(meldingRows(PAND, [])).toEqual([]);
  });
});
