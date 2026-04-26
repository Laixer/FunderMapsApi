export const GeocoderDatasource = {
  Unknown: 0,
  FunderMaps: 1,
  NlPostcode: 5,
  NlBagBuilding: 6,
  NlBagBerth: 7,
  NlBagPosting: 8,
  NlBagResidence: 9,
  NlBagAddress: 10,
  NlCbsNeighborhood: 11,
  NlCbsDistrict: 12,
  NlCbsMunicipality: 13,
  NlCbsState: 14,
  NlBagLegacyBuilding: 15,
  NlBagLegacyAddress: 16,
  NlBagLegacyBerth: 17,
  NlBagLegacyPosting: 18,
  NlBagLegacyBuildingShort: 19,
  NlBagLegacyAddressShort: 20,
  NlBagLegacyBerthShort: 21,
  NlBagLegacyPostingShort: 22,
} as const;

export type GeocoderDatasource =
  (typeof GeocoderDatasource)[keyof typeof GeocoderDatasource];

const postcodeRegex = /^\d{4}[a-zA-Z]{2}$/;

export function fromIdentifier(input: string): GeocoderDatasource {
  // FunderMaps internal IDs are lowercase `gfm-{uuid-no-dashes}` — keep
  // the prefix check before the upper-casing line below.
  if (input.startsWith("gfm-")) return GeocoderDatasource.FunderMaps;

  const id = input.replaceAll(" ", "").toUpperCase();

  if (id.startsWith("NL.IMBAG.PAND.")) return GeocoderDatasource.NlBagBuilding;
  if (id.startsWith("NL.IMBAG.LIGPLAATS."))
    return GeocoderDatasource.NlBagBerth;
  if (id.startsWith("NL.IMBAG.STANDPLAATS."))
    return GeocoderDatasource.NlBagPosting;
  if (id.startsWith("NL.IMBAG.VERBLIJFSOBJECT."))
    return GeocoderDatasource.NlBagResidence;
  if (id.startsWith("NL.IMBAG.NUMMERAANDUIDING."))
    return GeocoderDatasource.NlBagAddress;

  if (id.length === 16 && id.substring(4, 6) === "10")
    return GeocoderDatasource.NlBagLegacyBuilding;
  if (id.length === 16 && id.substring(4, 6) === "20")
    return GeocoderDatasource.NlBagLegacyAddress;
  if (id.length === 16 && id.substring(4, 6) === "02")
    return GeocoderDatasource.NlBagLegacyBerth;
  if (id.length === 16 && id.substring(4, 6) === "03")
    return GeocoderDatasource.NlBagLegacyPosting;

  if (id.length === 15 && id.substring(3, 5) === "10")
    return GeocoderDatasource.NlBagLegacyBuildingShort;
  if (id.length === 15 && id.substring(3, 5) === "20")
    return GeocoderDatasource.NlBagLegacyAddressShort;
  if (id.length === 15 && id.substring(3, 5) === "02")
    return GeocoderDatasource.NlBagLegacyBerthShort;
  if (id.length === 15 && id.substring(3, 5) === "03")
    return GeocoderDatasource.NlBagLegacyPostingShort;

  if (id.length === 10 && id.startsWith("BU"))
    return GeocoderDatasource.NlCbsNeighborhood;
  if (id.length === 8 && id.startsWith("WK"))
    return GeocoderDatasource.NlCbsDistrict;
  if (id.length === 6 && id.startsWith("GM"))
    return GeocoderDatasource.NlCbsMunicipality;
  if (id.length === 4 && id.startsWith("PV"))
    return GeocoderDatasource.NlCbsState;

  if (postcodeRegex.test(id)) return GeocoderDatasource.NlPostcode;

  return GeocoderDatasource.Unknown;
}
