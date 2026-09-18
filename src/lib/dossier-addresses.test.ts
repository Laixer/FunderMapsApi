import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.APP_ID ??= "test";
process.env.AUTH_SECRET ??= "test-secret";

const { formatAddress, mergeAddresses } = await import("./dossier-addresses.ts");
type AddressInfo = import("./dossier-addresses.ts").AddressInfo;

const info = new Map<string, AddressInfo>([
  ["NL.IMBAG.NUMMERAANDUIDING.OWN", { id: "NL.IMBAG.NUMMERAANDUIDING.OWN", externalId: "NL.IMBAG.NUMMERAANDUIDING.OWN", buildingId: "NL.IMBAG.PAND.1", label: "Molenwal 15, 3421 CK Oudewater" }],
  ["NL.IMBAG.NUMMERAANDUIDING.17", { id: "NL.IMBAG.NUMMERAANDUIDING.17", externalId: "NL.IMBAG.NUMMERAANDUIDING.17", buildingId: "NL.IMBAG.PAND.2", label: "Molenwal 17, 3421 CK Oudewater" }],
  ["NL.IMBAG.NUMMERAANDUIDING.19", { id: "NL.IMBAG.NUMMERAANDUIDING.19", externalId: "NL.IMBAG.NUMMERAANDUIDING.19", buildingId: "NL.IMBAG.PAND.3", label: "Molenwal 19, 3421 CK Oudewater" }],
  ["NL.IMBAG.NUMMERAANDUIDING.59A", { id: "NL.IMBAG.NUMMERAANDUIDING.59A", externalId: "NL.IMBAG.NUMMERAANDUIDING.59A", buildingId: "NL.IMBAG.PAND.4", label: "Molenwal 59A, 3421 CK Oudewater" }],
]);
const own = info.get("NL.IMBAG.NUMMERAANDUIDING.OWN")!;

describe("formatAddress", () => {
  test("street number, postcode city", () => {
    expect(formatAddress({ street: "Molenwal", buildingNumber: "15", postalCode: "3421 CK", city: "Oudewater" })).toBe(
      "Molenwal 15, 3421 CK Oudewater",
    );
  });
  test("survives missing parts", () => {
    expect(formatAddress({ street: "Molenwal", buildingNumber: "15", postalCode: null, city: "Oudewater" })).toBe("Molenwal 15, Oudewater");
    expect(formatAddress({ street: "Molenwal", buildingNumber: null, postalCode: null, city: null })).toBe("Molenwal");
  });
});

describe("mergeAddresses", () => {
  test("own pand first, confirmed and own, even without values", () => {
    const list = mergeAddresses({ own, rows: [], groups: [], info });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "NL.IMBAG.NUMMERAANDUIDING.OWN", own: true, source: "melder", state: "confirmed", label: own.label, open: 0 });
  });

  test("addresses the pipeline found are pending entries with counts; document-level values are not an address", () => {
    const list = mergeAddresses({
      own,
      rows: [],
      groups: [
        { addressId: null, addressText: null, open: 3, total: 4, superseded: 0 },
        { addressId: "NL.IMBAG.NUMMERAANDUIDING.17", addressText: "Molenwal 17", open: 2, total: 5, superseded: 0 },
        { addressId: null, addressText: "Molenwal 21", open: 1, total: 1, superseded: 0 },
      ],
      info,
    });
    expect(list.map((a) => a.key)).toEqual(["NL.IMBAG.NUMMERAANDUIDING.OWN", "NL.IMBAG.NUMMERAANDUIDING.17", "text:Molenwal 21"]);
    expect(list[1]).toMatchObject({ addressId: "NL.IMBAG.NUMMERAANDUIDING.17", addressText: "Molenwal 17", state: "pending", source: "pipeline", open: 2, total: 5, label: info.get("NL.IMBAG.NUMMERAANDUIDING.17")!.label });
    expect(list[2]).toMatchObject({ addressId: null, addressText: "Molenwal 21", label: null, buildingId: null, open: 1 });
  });

  test("two spellings that resolved to one address are one entry", () => {
    const list = mergeAddresses({
      own: null,
      rows: [],
      groups: [
        { addressId: "NL.IMBAG.NUMMERAANDUIDING.17", addressText: "Molenwal 17", open: 1, total: 1, superseded: 0 },
        { addressId: "NL.IMBAG.NUMMERAANDUIDING.17", addressText: "Molenwal 17 te Oudewater", open: 1, total: 2, superseded: 0 },
      ],
      info,
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ addressText: "Molenwal 17 / Molenwal 17 te Oudewater", open: 2, total: 3 });
  });

  test("a row wins over the derived entry, and a rejected address sorts last", () => {
    const list = mergeAddresses({
      own,
      rows: [
        { addressId: "NL.IMBAG.NUMMERAANDUIDING.17", addressText: null, source: "pipeline", state: "rejected", note: "andere straat", decidedAt: new Date("2026-09-14T10:00:00Z") },
        { addressId: "NL.IMBAG.NUMMERAANDUIDING.59A", addressText: null, source: "reviewer", state: "confirmed", note: null, decidedAt: new Date("2026-09-14T10:01:00Z") },
      ],
      groups: [
        { addressId: "NL.IMBAG.NUMMERAANDUIDING.17", addressText: "Molenwal 17", open: 0, total: 2, superseded: 0 },
        { addressId: "NL.IMBAG.NUMMERAANDUIDING.19", addressText: "Molenwal 19", open: 3, total: 3, superseded: 0 },
      ],
      info,
    });
    expect(list.map((a) => a.key)).toEqual(["NL.IMBAG.NUMMERAANDUIDING.OWN", "NL.IMBAG.NUMMERAANDUIDING.59A", "NL.IMBAG.NUMMERAANDUIDING.19", "NL.IMBAG.NUMMERAANDUIDING.17"]);
    expect(list[1]).toMatchObject({ source: "reviewer", state: "confirmed", open: 0, total: 0 });
    expect(list[3]).toMatchObject({ state: "rejected", note: "andere straat", addressText: "Molenwal 17", total: 2, decidedAt: "2026-09-14T10:00:00.000Z" });
  });

  test("a decision on the own pand keeps it first and own", () => {
    const list = mergeAddresses({
      own,
      rows: [{ addressId: "NL.IMBAG.NUMMERAANDUIDING.OWN", addressText: "Molenwal 15", source: "pipeline", state: "confirmed", note: "ok", decidedAt: null }],
      groups: [{ addressId: "NL.IMBAG.NUMMERAANDUIDING.OWN", addressText: "Molenwal 15", open: 2, total: 2, superseded: 0 }],
      info,
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ own: true, source: "melder", state: "confirmed", note: "ok", addressText: "Molenwal 15", open: 2 });
  });

  test("an unresolved address whose values were all put aside reads as rejected", () => {
    const list = mergeAddresses({ own: null, rows: [], groups: [{ addressId: null, addressText: "Molenwal 21", open: 0, total: 0, superseded: 2 }], info });
    expect(list[0]).toMatchObject({ key: "text:Molenwal 21", state: "rejected", open: 0 });
  });

  test("no own pand: the list starts with what the document names", () => {
    const list = mergeAddresses({ own: null, rows: [], groups: [{ addressId: "NL.IMBAG.NUMMERAANDUIDING.19", addressText: "Molenwal 19", open: 1, total: 1, superseded: 0 }], info });
    expect(list.map((a) => a.own)).toEqual([false]);
  });
});
