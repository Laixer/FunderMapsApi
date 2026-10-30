import { describe, expect, test } from "bun:test";
import { isOnHost } from "./host-profile.ts";

describe("isOnHost", () => {
  test("a request to the map's host is on it, whatever the path or scheme inside the app", () => {
    expect(isOnHost("https://api.fundermaps.com/api/auth/passkey/generate-authenticate-options", "https://api.fundermaps.com")).toBe(true);
    // Behind the Studio's server the request URL is http on the same Host.
    expect(isOnHost("http://api.fundermaps.com/api/user/metadata", "https://api.fundermaps.com")).toBe(true);
  });
  test("the Studio's own host is not the map's", () => {
    expect(isOnHost("https://studio.funderdata.nl/api/auth/get-session", "https://api.fundermaps.com")).toBe(false);
    expect(isOnHost("https://melden.fundermaps.com/api/submission", "https://api.fundermaps.com")).toBe(false);
  });
  test("no map host set (api-prod): never", () => {
    expect(isOnHost("https://api.fundermaps.com/api/auth/get-session", undefined)).toBe(false);
  });
  test("the host is compared without case", () => {
    expect(isOnHost("https://API.FunderMaps.com/api/x", "https://api.fundermaps.com/")).toBe(true);
  });
});
