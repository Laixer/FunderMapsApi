import { describe, test, expect } from "bun:test";
import { fromIdentifier, GeocoderDatasource } from "./geocoder-id.ts";

// fromIdentifier is the API's input classifier — every customer-supplied
// identifier (BAG, CBS, GFM, postcode, legacy short/long forms) passes
// through here before any DB lookup. A regression that misclassifies one
// format as another silently joins on the wrong column → wrong building
// data on a billable call.
//
// Table-driven so adding a new format is one row, and so the case list
// reads as a spec rather than a series of imperative assertions.

const cases: { input: string; expected: GeocoderDatasource; why: string }[] = [
  // GFM — strict lowercase prefix BEFORE the upcase step. This is the
  // landmine: any other-case variant falls through and the upcase yields
  // a string that doesn't match any subsequent branch → Unknown.
  { input: "gfm-abc123", expected: GeocoderDatasource.FunderMaps, why: "canonical lowercase prefix" },
  { input: "gfm-d59e72f0", expected: GeocoderDatasource.FunderMaps, why: "uuid-shaped tail" },
  { input: "GFM-abc123", expected: GeocoderDatasource.Unknown, why: "uppercase GFM- intentionally NOT matched (prefix check is case-sensitive)" },

  // BAG — five `NL.IMBAG.*` variants. All upper-cased before prefix check,
  // so lowercase input still classifies correctly.
  { input: "NL.IMBAG.PAND.0344100000000001", expected: GeocoderDatasource.NlBagBuilding, why: "PAND" },
  { input: "nl.imbag.pand.0344100000000001", expected: GeocoderDatasource.NlBagBuilding, why: "lowercase upcases first" },
  { input: "NL.IMBAG.LIGPLAATS.0344020000000001", expected: GeocoderDatasource.NlBagBerth, why: "LIGPLAATS (berth)" },
  { input: "NL.IMBAG.STANDPLAATS.0344030000000001", expected: GeocoderDatasource.NlBagPosting, why: "STANDPLAATS (posting)" },
  { input: "NL.IMBAG.VERBLIJFSOBJECT.0344010000000001", expected: GeocoderDatasource.NlBagResidence, why: "VERBLIJFSOBJECT (residence)" },
  { input: "NL.IMBAG.NUMMERAANDUIDING.0344200000000001", expected: GeocoderDatasource.NlBagAddress, why: "NUMMERAANDUIDING (address)" },
  { input: "NL.IMBAG.PAND.0344 1000 0000 0001", expected: GeocoderDatasource.NlBagBuilding, why: "internal whitespace stripped before length-sensitive prefix check" },

  // Legacy BAG long form (16 digits, type discriminator at positions 4-5)
  { input: "0344100000000001", expected: GeocoderDatasource.NlBagLegacyBuilding, why: "16-digit, 10 at pos 4-5" },
  { input: "0344200000000001", expected: GeocoderDatasource.NlBagLegacyAddress, why: "16-digit, 20 at pos 4-5" },
  { input: "0344020000000001", expected: GeocoderDatasource.NlBagLegacyBerth, why: "16-digit, 02 at pos 4-5" },
  { input: "0344030000000001", expected: GeocoderDatasource.NlBagLegacyPosting, why: "16-digit, 03 at pos 4-5" },

  // Legacy BAG short form (15 digits, type discriminator at positions 3-4)
  { input: "344100000000001", expected: GeocoderDatasource.NlBagLegacyBuildingShort, why: "15-digit short" },
  { input: "344200000000001", expected: GeocoderDatasource.NlBagLegacyAddressShort, why: "15-digit short, addr" },
  { input: "344020000000001", expected: GeocoderDatasource.NlBagLegacyBerthShort, why: "15-digit short, berth" },
  { input: "344030000000001", expected: GeocoderDatasource.NlBagLegacyPostingShort, why: "15-digit short, posting" },

  // CBS codes — strict length + prefix match
  { input: "BU01234567", expected: GeocoderDatasource.NlCbsNeighborhood, why: "BU + 8 digits, 10 chars" },
  { input: "bu01234567", expected: GeocoderDatasource.NlCbsNeighborhood, why: "lowercase upcases first" },
  { input: "WK012345", expected: GeocoderDatasource.NlCbsDistrict, why: "WK + 6 digits, 8 chars" },
  { input: "GM0123", expected: GeocoderDatasource.NlCbsMunicipality, why: "GM + 4 digits, 6 chars" },
  { input: "PV01", expected: GeocoderDatasource.NlCbsState, why: "PV + 2 digits, 4 chars" },

  // Postcode (Dutch 4-digit + 2-letter)
  { input: "1011AB", expected: GeocoderDatasource.NlPostcode, why: "canonical postcode" },
  { input: "1011ab", expected: GeocoderDatasource.NlPostcode, why: "lowercase upcases first" },
  { input: "10 11 AB", expected: GeocoderDatasource.NlPostcode, why: "whitespace stripped" },

  // Unknown / rejected — guards against false-positive classification
  { input: "", expected: GeocoderDatasource.Unknown, why: "empty string" },
  { input: "totally-bogus", expected: GeocoderDatasource.Unknown, why: "random string" },
  { input: "BU0123456", expected: GeocoderDatasource.Unknown, why: "BU code one char short (9 not 10)" },
  { input: "BU012345678", expected: GeocoderDatasource.Unknown, why: "BU code one char long (11 not 10)" },
  { input: "0344999999999999", expected: GeocoderDatasource.Unknown, why: "16 digits but unrecognised middle pair (99)" },
  { input: "12345", expected: GeocoderDatasource.Unknown, why: "5 digits — between short legacy (15) and CBS lengths" },
  { input: "101A1B", expected: GeocoderDatasource.Unknown, why: "looks postcode-ish but pattern doesn't match" },
];

describe("fromIdentifier", () => {
  for (const { input, expected, why } of cases) {
    test(`"${input}" → ${expected} (${why})`, () => {
      expect(fromIdentifier(input)).toBe(expected);
    });
  }
});
