// The "to" of a mail: a bare address, or "Name <address>" when there is a name
// that can stand in front of it. One place, so the mails to staff and the mails
// to a melder guard the name the same way.

/**
 * A name is free text (the account page, the melden form); these characters
 * would end or split the address in a "Name <address>" recipient.
 */
function headerName(name: string): string {
  return name.replace(/[<>()[\]:;,"\\\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/** "Name <address>", or the bare address when no usable name is left. */
export function namedRecipient(email: string, name: string | null | undefined): string {
  const display = headerName(name ?? "");
  return display ? `${display} <${email}>` : email;
}
