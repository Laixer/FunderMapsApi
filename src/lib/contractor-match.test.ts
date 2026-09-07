import { describe, expect, test } from "bun:test";
import { matchContractor, normaliseContractorName } from "./contractor-match.ts";

const rows = [
  { id: 10, name: "FunderMaps B.V." },
  { id: 1241, name: "Wareco" },
  { id: 1252, name: "Fugro" },
  { id: 1280, name: "Techniek en Methode" },
  { id: 1291, name: "Techniek & Methode" },
  { id: 1314, name: "IMG" },
  { id: 1246, name: "BVL bouwadvies" },
  { id: 703, name: "Gemeente Rotterdam" },
];

describe("normaliseContractorName", () => {
  test("drops legal form and punctuation", () => {
    expect(normaliseContractorName("Fugro GeoServices B.V.")).toBe("fugro geoservices");
    expect(normaliseContractorName("Techniek & Methode BV")).toBe("techniek en methode");
    expect(normaliseContractorName("FunderMaps B.V.")).toBe("fundermaps");
  });
});

describe("matchContractor", () => {
  test("exact after normalisation", () => {
    expect(matchContractor("wareco", rows)?.id).toBe(1241);
    expect(matchContractor("Techniek en Methode B.V.", rows)?.id).toBe(1280);
  });
  test("letterhead longer than the row", () => {
    expect(matchContractor("Fugro GeoServices B.V.", rows)?.id).toBe(1252);
    expect(matchContractor("Wareco Ingenieurs", rows)?.id).toBe(1241);
  });
  test("row longer than the printed name", () => {
    expect(matchContractor("BVL", rows)).toBeNull(); // 3 chars: too short to claim
    expect(matchContractor("Gemeente Rotterdam, afdeling Bouw", rows)?.id).toBe(703);
    expect(matchContractor("Gemeente Rotterdam Stadsontwikkeling", rows)?.id).toBe(703);
  });
  test("short codes never claim by prefix", () => {
    expect(matchContractor("IMG Ingenieurs", rows)).toBeNull();
    expect(matchContractor("Imgenieursbureau X", rows)).toBeNull();
  });
  test("unknown bureau", () => {
    expect(matchContractor("Duyts bouwconstructies", rows)).toBeNull();
    expect(matchContractor("", rows)).toBeNull();
  });
});
