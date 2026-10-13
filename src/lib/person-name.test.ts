import { describe, expect, test } from "bun:test";
import { ownName, personName } from "./person-name.ts";

// `user.name` is the e-mail address for an account made without a name, so a
// trail or an assignment that put `name` first showed people as an address.

const email = "jan@example.test";

describe("ownName", () => {
  test("a name is kept, without the spaces around it", () => {
    expect(ownName("Jan Jansen")).toBe("Jan Jansen");
    expect(ownName("  Jan Jansen ")).toBe("Jan Jansen");
  });

  test("nothing, or an e-mail address, is no name", () => {
    for (const name of [null, undefined, "", "   ", email, ` ${email} `, "ander@example.test", "Jan @ kantoor"]) {
      expect(ownName(name)).toBe("");
    }
  });
});

describe("personName", () => {
  test("the given and the family name come first", () => {
    expect(personName({ name: email, givenName: "Jan", lastName: "Jansen", email })).toBe("Jan Jansen");
    expect(personName({ name: "J. Jansen", givenName: "Jan", lastName: "Jansen", email })).toBe("Jan Jansen");
    expect(personName({ name: null, givenName: " Jan ", lastName: " de Vries ", email })).toBe("Jan de Vries");
  });

  test("one of the two is enough", () => {
    expect(personName({ name: email, givenName: "Jan", lastName: null, email })).toBe("Jan");
    expect(personName({ name: email, givenName: "", lastName: "Jansen", email })).toBe("Jansen");
  });

  test("then `name`, when it is a name", () => {
    expect(personName({ name: "J. Jansen", givenName: null, lastName: null, email })).toBe("J. Jansen");
    expect(personName({ name: " J. Jansen ", givenName: " ", lastName: "", email })).toBe("J. Jansen");
  });

  test("then the e-mail address: staff must still see who it was", () => {
    expect(personName({ name: email, givenName: null, lastName: null, email })).toBe(email);
    expect(personName({ name: "ander@example.test", givenName: null, lastName: null, email })).toBe(email);
    expect(personName({ name: null, givenName: null, lastName: null, email })).toBe(email);
    expect(personName({ name: "  ", givenName: " ", lastName: "  ", email })).toBe(email);
    expect(personName({ email })).toBe(email);
  });
});
