/**
 * The mails about a user's own account. Dutch, like the login pages they are
 * asked for from, and in the same voice ("je").
 */

import { escapeHtml, wrapHtml } from "./mail-html.ts";
import { ownName } from "./person-name.ts";

/**
 * The password-reset mail. `url` is Better Auth's one-time link, valid for an hour. `user` is the
 * account as Better Auth hands it to sendResetPassword: the given name comes with it (an additional
 * field in auth.ts).
 */
export function resetPasswordMail(
  user: { email: string; name?: string | null; givenName?: string | null },
  url: string,
): { subject: string; text: string; html: string } {
  // "Hallo Jan," by the given name, as "je" goes with. Most accounts have their e-mail address in
  // `name`; without a given name the mail greets nobody by name rather than "Hallo jan@voorbeeld.nl,".
  const name = ownName(user.givenName) || ownName(user.name);
  const greeting = name ? `Hallo ${name},` : "Hallo,";
  const asked = `Er is een nieuw wachtwoord aangevraagd voor je FunderMaps-account.`;
  const open = `Open de link hieronder om een nieuw wachtwoord in te stellen (1 uur geldig):`;
  const notYou = `Heb je dit niet zelf aangevraagd? Dan hoef je niets te doen: je wachtwoord blijft zoals het is.`;
  return {
    subject: "Nieuw wachtwoord instellen voor FunderMaps",
    text: `${greeting}\n\n${asked}\n\n${open}\n${url}\n\n${notYou}\n\nMet vriendelijke groet,\nFunderMaps`,
    // The same words. The link is a text link here: the address itself is some
    // 140 characters and breaks over three lines on a phone. The text version
    // keeps it in full.
    html: wrapHtml(
      `<p>${escapeHtml(greeting)}</p>` +
        `<p>${escapeHtml(asked)}</p>` +
        `<p>${escapeHtml(open)}</p>` +
        `<p><a href="${escapeHtml(url)}">Nieuw wachtwoord instellen</a></p>` +
        `<p>${escapeHtml(notYou)}</p>` +
        `<p>Met vriendelijke groet,<br>FunderMaps</p>`,
    ),
  };
}
