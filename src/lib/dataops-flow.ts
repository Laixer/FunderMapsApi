/**
 * Where every dossier stands, for the Data Studio's Datastroom page.
 *
 * One bucket per dossier, so the buckets of a channel add up to everything
 * that channel ever brought in. The order is the order of the pipeline: what
 * became a rapportage, what was closed without one, and what is still open,
 * from "nothing to read" to "every value judged".
 *
 * The open buckets follow the queue's own states (routes/dataops.ts):
 * `question` is a dossier without a file, `unread` one the reader has not read
 * yet, `empty` one it read and found nothing in, `proposals` one with values
 * still to judge. `judged` is the one the queue has no word for: every value
 * judged, the dossier still open.
 */

export const CLOSED_BUCKETS = ["rapportage", "accepted", "no_data", "rejected", "duplicate"] as const;
export const OPEN_BUCKETS = ["question", "unread", "empty", "proposals", "judged"] as const;
export const FLOW_BUCKETS = [...CLOSED_BUCKETS, ...OPEN_BUCKETS] as const;
export type FlowBucket = (typeof FLOW_BUCKETS)[number];

const OUTCOMES = new Set<string>(["accepted", "no_data", "rejected", "duplicate"]);

/** What the database knows about a group of dossiers, as yes/no facts. */
export interface FlowFacts {
  /** Committed: the dossier became (part of) a rapportage. */
  inquiry: boolean;
  outcome: string | null;
  files: boolean;
  read: boolean;
  found: boolean;
  open: boolean;
}

export function flowBucket(f: FlowFacts): FlowBucket {
  // A rapportage wins over the outcome it was closed with: 1,311 committed
  // dossiers say `accepted`, 6 say `no_data` (2026-10-22), and all of them
  // are in FunderMaps.
  if (f.inquiry) return "rapportage";
  if (f.outcome !== null) {
    // A new outcome in the database enum must be given a place here; counting
    // it as one of the others would make the picture quietly wrong.
    if (!OUTCOMES.has(f.outcome)) throw new Error(`unknown dossier outcome: ${f.outcome}`);
    return f.outcome as FlowBucket;
  }
  if (!f.files) return "question";
  if (!f.read) return "unread";
  if (!f.found) return "empty";
  return f.open ? "proposals" : "judged";
}

export interface FlowCount {
  channel: string;
  bucket: FlowBucket;
  count: number;
}

/** Groups of facts, per channel, added up per bucket; in pipeline order, empty buckets left out. */
export function addUp(groups: (FlowFacts & { channel: string; count: number })[]): FlowCount[] {
  const sums = new Map<string, FlowCount>();
  for (const g of groups) {
    const bucket = flowBucket(g);
    const key = `${g.channel}\u0000${bucket}`;
    const sum = sums.get(key) ?? { channel: g.channel, bucket, count: 0 };
    sum.count += g.count;
    sums.set(key, sum);
  }
  const order = (b: FlowBucket) => FLOW_BUCKETS.indexOf(b);
  return [...sums.values()]
    .filter((s) => s.count > 0)
    .sort((a, b) => a.channel.localeCompare(b.channel) || order(a.bucket) - order(b.bucket));
}

export interface FlowWeek {
  /** Monday the week starts on, YYYY-MM-DD. */
  week: string;
  channel: string;
  received: number;
  closed: number;
}

/**
 * Received and closed per week and channel, dense: every week in `weeks` for
 * every channel that appears at all, zero where nothing happened, so a
 * sparkline has a point for each week.
 */
export function weekly(
  weeks: string[],
  received: { week: string; channel: string; count: number }[],
  closed: { week: string; channel: string; count: number }[],
): FlowWeek[] {
  const channels = [...new Set([...received, ...closed].map((r) => r.channel))].sort();
  const key = (week: string, channel: string) => `${week}\u0000${channel}`;
  const rec = new Map(received.map((r) => [key(r.week, r.channel), r.count]));
  const clo = new Map(closed.map((r) => [key(r.week, r.channel), r.count]));
  return channels.flatMap((channel) =>
    weeks.map((week) => ({
      week,
      channel,
      received: rec.get(key(week, channel)) ?? 0,
      closed: clo.get(key(week, channel)) ?? 0,
    })),
  );
}
