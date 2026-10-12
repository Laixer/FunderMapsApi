import { ValidationError } from "./errors.ts";

/** How a dossier can be closed; the values `outcome=` accepts on the queue. */
export const CLOSED_OUTCOMES = new Set(["rejected", "duplicate", "no_data", "accepted"]);

export type QueueScope = { kind: "desk" } | { kind: "all" } | { kind: "outcomes"; outcomes: string[] };

/**
 * Which line a queue request is about.
 *
 *  - the desk (default): dossiers nobody closed or committed yet;
 *  - `outcome=…`: dossiers closed with one of those outcomes, the fixed tabs
 *    Afgewezen, Duplicaten and so on;
 *  - every dossier, open or closed: `state=replied` (a reply on a closed
 *    dossier is the one nobody saw) and `scope=all`.
 *
 * `scope=all` is what the Studio sends with a search typed on the "Alles"
 * view (#191, Don 2026-09-19: "je zou dat ook verwachten te vinden onder
 * Alles"). It is a parameter, not something a search term implies, because a
 * search term is also how a work package selects its slice of the desk: those
 * counts must keep meaning "still to do". An explicit `outcome` wins over it.
 */
export function queueScopeOf(input: { outcomes: string[]; states: string[]; scope: string | undefined }): QueueScope {
  const { outcomes, states, scope } = input;
  if (scope !== undefined && scope !== "desk" && scope !== "all") {
    throw new ValidationError([`scope must be desk or all`]);
  }
  if (outcomes.length) {
    const bad = outcomes.filter((x) => !CLOSED_OUTCOMES.has(x));
    if (bad.length) throw new ValidationError([`unknown outcome: ${bad.join(", ")}`]);
    return { kind: "outcomes", outcomes };
  }
  if (scope === "all" || states.includes("replied")) return { kind: "all" };
  return { kind: "desk" };
}
