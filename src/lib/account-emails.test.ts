import { describe, expect, test } from "bun:test";
import { resetPasswordMail } from "./account-emails.ts";

// The password-reset mail goes to customers who asked for it on a Dutch login
// page, so it is Dutch, and it must carry the link it was given unchanged.

const URL_IN_MAIL =
  "https://api.fundermaps.com/api/auth/reset-password/TOKEN?callbackURL=https%3A%2F%2Fauth.fundermaps.com%2Freset-password";

describe("resetPasswordMail", () => {
  test("is Dutch", () => {
    const mail = resetPasswordMail({ email: "jan@example.test", name: "Jan Jansen" }, URL_IN_MAIL);
    expect(mail.subject).toBe("Nieuw wachtwoord instellen voor FunderMaps");
    expect(mail.text).toStartWith("Hallo Jan Jansen,\n\n");
    expect(mail.text).toEndWith("Met vriendelijke groet,\nFunderMaps");
    // No English left in the words around the link (the link itself says "reset-password").
    const words = mail.text.replace(URL_IN_MAIL, "");
    expect(words).not.toMatch(/\b(password|requested|ignore|unchanged)\b/i);
  });

  test("carries the link unchanged, on a line of its own, and says how long it is valid", () => {
    const mail = resetPasswordMail({ email: "jan@example.test", name: "Jan Jansen" }, URL_IN_MAIL);
    expect(mail.text.split("\n")).toContain(URL_IN_MAIL);
    expect(mail.text).toContain("1 uur geldig");
  });

  test("greets by e-mail address when the user has no name", () => {
    for (const name of ["", null, undefined]) {
      const mail = resetPasswordMail({ email: "geen-naam@example.test", name }, URL_IN_MAIL);
      expect(mail.text).toStartWith("Hallo geen-naam@example.test,\n\n");
    }
  });
});
