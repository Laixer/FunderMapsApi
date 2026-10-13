// What to call a person, on screen and in a greeting.
//
// `user.name` is not a dependable name: an account made in the admin portal
// gets its e-mail address there, and the portal edits the given and the family
// name only. So those two come first, and a `name` with an "@" in it counts
// as no name.

/** `user.name` when it is a name: "" when it is empty or an e-mail address. */
export function ownName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";
  return trimmed.includes("@") ? "" : trimmed;
}

/**
 * Who this is, for staff: the given and family name, else `user.name`, else
 * the e-mail address. Never empty: staff must still see who it was.
 */
export function personName(u: {
  name?: string | null;
  givenName?: string | null;
  lastName?: string | null;
  email: string;
}): string {
  const full = [u.givenName, u.lastName].map((part) => part?.trim()).filter(Boolean).join(" ");
  return full || ownName(u.name) || u.email;
}
