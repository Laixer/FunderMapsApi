// The HTML half of the mails the API sends: a light wrapper around the same
// words as the plain text. One place, so the mails cannot drift apart in style.

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The outer block of every mail. `overflow-wrap` (and `word-break` for the
 * clients that only know the older spelling) because a file name or a BAG id
 * is one long word: without it the mail is wider than a phone screen.
 */
export function wrapHtml(inner: string): string {
  return (
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;overflow-wrap:anywhere;word-break:break-word">` +
    inner +
    `</div>`
  );
}
