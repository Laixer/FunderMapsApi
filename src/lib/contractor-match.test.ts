import { describe, expect, test } from "bun:test";
import {
  findDuplicateContractor,
  matchContractor,
  normaliseContractorName,
} from "./contractor-match.ts";

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

describe("findDuplicateContractor", () => {
  test("a spelling of a row we already have is not new", () => {
    // The 47 pairs measured on the extracted values: same firm, different coat.
    expect(findDuplicateContractor("Fugro NL Land B.V.", rows)?.id).toBe(1252);
    expect(findDuplicateContractor("FUGRO", rows)?.id).toBe(1252);
    expect(findDuplicateContractor("Techniek & Methode B.V.", rows)?.id).toBe(1280);
  });
  test("a firm we do not have is new", () => {
    expect(findDuplicateContractor("Hightower Group B.V.", rows)).toBeNull();
    expect(findDuplicateContractor("Funderingsloket Haarlem", rows)).toBeNull();
    expect(findDuplicateContractor("brainbay", rows)).toBeNull();
  });
  test("a blank name is never a duplicate, so the route must reject it first", () => {
    expect(findDuplicateContractor("   ", rows)).toBeNull();
  });
});
