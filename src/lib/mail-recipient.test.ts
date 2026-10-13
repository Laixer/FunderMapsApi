import { describe, expect, test } from "bun:test";
import { namedRecipient } from "./mail-recipient.ts";

// The "to" of the mails to staff (the name of an account) and of the mails to a
// melder (whatever was typed in the name field of the melden form).

describe("namedRecipient", () => {
  test("a name stands in front of the address", () => {
    expect(namedRecipient("jan@example.test", "Jan de Vries")).toBe("Jan de Vries <jan@example.test>");
    expect(namedRecipient("jan@example.test", "  J. de Vries-van den Berg  ")).toBe("J. de Vries-van den Berg <jan@example.test>");
  });

  test("no name gives the bare address", () => {
    for (const name of ["", "   ", null, undefined]) {
      expect(namedRecipient("jan@example.test", name)).toBe("jan@example.test");
    }
  });

  test("what a melder types cannot end or split the address", () => {
    expect(namedRecipient("jan@example.test", "Vries, Jan de")).toBe("Vries Jan de <jan@example.test>");
    expect(namedRecipient("jan@example.test", "Jan de Vries (eigenaar)")).toBe("Jan de Vries eigenaar <jan@example.test>");
    expect(namedRecipient("jan@example.test", 'Jan "de buurman" de Vries')).toBe("Jan de buurman de Vries <jan@example.test>");
    expect(namedRecipient("jan@example.test", "Jan <iemand@elders.test>")).toBe("Jan iemand@elders.test <jan@example.test>");
    expect(namedRecipient("jan@example.test", "VvE Voorbeeldstraat 1-9; namens: het bestuur")).toBe(
      "VvE Voorbeeldstraat 1-9 namens het bestuur <jan@example.test>",
    );
    expect(namedRecipient("jan@example.test", "Jan\r\nBcc: iemand@elders.test")).toBe("Jan Bcc iemand@elders.test <jan@example.test>");
    expect(namedRecipient("jan@example.test", "Jan\\de Vries [beheer]")).toBe("Jan de Vries beheer <jan@example.test>");
  });

  test("a name of only such characters leaves the bare address", () => {
    expect(namedRecipient("jan@example.test", '<>,;:"()[]')).toBe("jan@example.test");
  });

  test("exactly one address between angle brackets, at the end", () => {
    for (const name of ["Jan de Vries", "Vries, Jan <x@y.test>", 'a "b" (c) [d]; e: f', "Jan\nde Vries"]) {
      const to = namedRecipient("jan@example.test", name);
      expect(to).toMatch(/^[^<>\r\n]* <jan@example\.test>$/);
    }
  });
});
