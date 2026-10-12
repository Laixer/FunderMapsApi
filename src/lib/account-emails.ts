/**
 * The mails about a user's own account. Dutch, like the login pages they are
 * asked for from, and in the same voice ("je").
 */

/** The password-reset mail. `url` is Better Auth's one-time link, valid for an hour. */
export function resetPasswordMail(
  user: { email: string; name?: string | null },
  url: string,
): { subject: string; text: string } {
  return {
    subject: "Nieuw wachtwoord instellen voor FunderMaps",
    text:
      `Hallo ${user.name || user.email},\n\n` +
      `Er is een nieuw wachtwoord aangevraagd voor je FunderMaps-account.\n\n` +
      `Open de link hieronder om een nieuw wachtwoord in te stellen (1 uur geldig):\n${url}\n\n` +
      `Heb je dit niet zelf aangevraagd? Dan hoef je niets te doen: je wachtwoord blijft zoals het is.\n\n` +
      `Met vriendelijke groet,\nFunderMaps`,
  };
}
