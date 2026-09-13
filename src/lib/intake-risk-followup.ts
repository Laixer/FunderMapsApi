/**
 * Moment 3, second half (tracker #1020, API #143 option B — Don 2026-09-11):
 * "is het risico aangepast, en wat is het nieuwe risico?"
 *
 * The afronding mail quotes the risk registered at the moment of closing and
 * says it is recalculated daily. The recalculation happens later (the model
 * refresh at 12:30 and 21:00), and the database keeps no history, so the only
 * way to answer "did it change" is to remember what the melder was told:
 *
 *   close/commit  → storeRiskSnapshot(): the per-building risk the afronding
 *                   mail showed goes into dossier.payload.risk_snapshot
 *   after refresh → sendRiskFollowups(): every closed dossier whose snapshot
 *                   predates the last successful refresh is compared with the
 *                   model's current row; changed → ONE mail (dossier_mail kind
 *                   'risk_changed'); either way the snapshot is marked checked
 *                   so the next run leaves it alone.
 *
 * No status change, no reopening: the dossier stays closed, the timeline gets
 * a line. Windmill calls the endpoint as the last step of the refresh flow.
 */

import { sql } from "drizzle-orm";
import { inArray } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dossier } from "../db/schema/dataops.ts";
import { model_risk_static } from "../db/schema/data.ts";
import { addEntry } from "./dossier-entries.ts";
import {
  type Block,
  type ClosedAddressSummary,
  type DossierHead,
  type RegisteredRisk,
  type RenderedMail,
  addressLine,
  deliver,
  loadHeads,
  mainAddress,
  questionReplyAddress,
  recipientOf,
  render,
  riskLabel,
  statusUrl,
} from "./intake-emails.ts";

export interface RiskSnapshot {
  /** When the afronding mail was prepared (ISO). Compared against data.refresh_log. */
  at: string;
  /** Per pand: the address the melder saw and the risk as registered then. */
  buildings: Record<string, { address: string; risk: RegisteredRisk | null }>;
  /** Set by the follow-up run; a checked snapshot is never looked at again. */
  checked_at?: string;
  changed?: boolean;
}

const RISK_FIELDS: { key: keyof RegisteredRisk; label: string }[] = [
  { key: "drystand", label: "droogstand" },
  { key: "dewateringDepth", label: "ontwateringsdiepte" },
  { key: "bioInfection", label: "bacteriële aantasting" },
  { key: "unclassified", label: "vastgesteld risico" },
];

export interface RiskChange {
  buildingId: string;
  address: string;
  fields: { label: string; before: string | null; after: string | null }[];
}

/** Which registered risks differ from the snapshot. Pure; the unit tests live here. */
export function compareRisk(
  snapshot: RiskSnapshot,
  current: Map<string, RegisteredRisk>,
): RiskChange[] {
  const changes: RiskChange[] = [];
  for (const [buildingId, was] of Object.entries(snapshot.buildings)) {
    const now = current.get(buildingId) ?? null;
    const fields = RISK_FIELDS.flatMap(({ key, label }) => {
      const before = was.risk?.[key] ?? null;
      const after = now?.[key] ?? null;
      // "unclassified" is only shown when set; going from nothing to nothing is not news.
      return (before ?? "") === (after ?? "") ? [] : [{ label, before, after }];
    });
    if (fields.length) changes.push({ buildingId, address: was.address, fields });
  }
  return changes;
}

export interface RiskChangedEmailInput {
  reference: string;
  recipientName: string;
  changes: RiskChange[];
  statusUrl: string;
  replyTo: string;
}

export function buildRiskChangedEmail(input: RiskChangedEmailInput): RenderedMail {
  const blocks: Block[] = [
    { p: `Beste ${input.recipientName || "melder"},` },
    {
      p:
        `Na de verwerking van uw melding ${input.reference} hebben wij het funderingsrisico opnieuw berekend. ` +
        `Voor ${input.changes.length === 1 ? "het volgende adres" : "de volgende adressen"} is het geregistreerde risico gewijzigd:`,
    },
  ];
  for (const c of input.changes) {
    blocks.push(
      { p: c.address },
      { ul: c.fields.map((f) => `${f.label}: ${riskLabel(f.before)} → ${riskLabel(f.after)}`) },
    );
  }
  blocks.push(
    {
      p:
        "Het funderingsrisico wordt dagelijks herberekend op basis van alle gegevens die bij ons bekend zijn, " +
        "en kan daardoor in de toekomst opnieuw veranderen.",
    },
    { p: "De status van uw melding kunt u volgen via:" },
    { url: input.statusUrl },
    { p: "Vragen hierover? Beantwoord deze e-mail. Uw reactie wordt automatisch aan uw melding gekoppeld." },
  );
  return render(`FunderMaps - Het funderingsrisico van uw melding ${input.reference} is herberekend`, blocks);
}

async function currentRisk(buildingIds: string[]): Promise<Map<string, RegisteredRisk>> {
  if (buildingIds.length === 0) return new Map();
  const rows = await db
    .select({
      buildingId: model_risk_static.building_id,
      drystand: model_risk_static.drystand_risk,
      dewateringDepth: model_risk_static.dewatering_depth_risk,
      bioInfection: model_risk_static.bio_infection_risk,
      unclassified: model_risk_static.unclassified_risk,
    })
    .from(model_risk_static)
    .where(inArray(model_risk_static.building_id, buildingIds));
  const out = new Map<string, RegisteredRisk>();
  for (const r of rows) {
    if (!r.buildingId) continue;
    out.set(r.buildingId, { drystand: r.drystand, dewateringDepth: r.dewateringDepth, bioInfection: r.bioInfection, unclassified: r.unclassified });
  }
  return out;
}

async function writeSnapshot(dossierId: number, snapshot: RiskSnapshot) {
  await db.execute(sql`
    update ${dossier}
       set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('risk_snapshot', ${JSON.stringify(snapshot)}::jsonb),
           updated_at = now()
     where id = ${dossierId}`);
}

/**
 * Remember what the afronding mail told the melder. Called right after that
 * mail; the addresses are the ones it listed, plus the dossier's own pand when
 * the mail listed none (a rejected melding still has a building whose risk
 * can move). Never throws — a missing snapshot only means no follow-up.
 */
export async function storeRiskSnapshot(head: DossierHead, addresses: ClosedAddressSummary[]): Promise<void> {
  try {
    if (!recipientOf(head)) return;
    const buildings: RiskSnapshot["buildings"] = {};
    for (const a of addresses) {
      if (a.buildingId && !buildings[a.buildingId]) buildings[a.buildingId] = { address: a.address, risk: a.risk };
    }
    if (head.buildingId && !buildings[head.buildingId]) {
      const main = await mainAddress(head.buildingId);
      const risk = (await currentRisk([head.buildingId])).get(head.buildingId) ?? null;
      buildings[head.buildingId] = { address: main ? addressLine(main) : head.bagId ?? "uw pand", risk };
    }
    if (Object.keys(buildings).length === 0) return;
    await writeSnapshot(head.id, { at: new Date().toISOString(), buildings });
  } catch (err) {
    console.error(`risk snapshot for dossier ${head.id} failed:`, err);
  }
}

export interface FollowupResult {
  /** finished_at of the last successful model refresh, or null when there is none on record. */
  lastRefresh: string | null;
  checked: number;
  changed: number;
  mailed: number;
  noRecipient: number;
  dryRun: boolean;
}

/**
 * The run after the model refresh. Idempotent: a snapshot is checked once,
 * and dossier_mail keeps 'risk_changed' to one per dossier even if it is not.
 */
export async function sendRiskFollowups(opts: { dryRun?: boolean; limit?: number } = {}): Promise<FollowupResult> {
  const dryRun = opts.dryRun ?? false;
  const result: FollowupResult = { lastRefresh: null, checked: 0, changed: 0, mailed: 0, noRecipient: 0, dryRun };

  const refresh = await db.execute<{ finished_at: string }>(sql`
    select max(finished_at)::text as finished_at from data.refresh_log
     where job = 'refresh_data_model' and status = 'ok'`);
  const lastRefresh = refresh[0]?.finished_at ?? null;
  result.lastRefresh = lastRefresh;
  if (!lastRefresh) return result;

  const due = await db.execute<{ id: number; snapshot: RiskSnapshot }>(sql`
    select id, payload->'risk_snapshot' as snapshot from ${dossier}
     where outcome is not null
       and payload ? 'risk_snapshot'
       and (payload->'risk_snapshot'->>'checked_at') is null
       and (payload->'risk_snapshot'->>'at')::timestamptz < ${lastRefresh}::timestamptz
     order by id
     limit ${opts.limit ?? 500}`);
  const rows: { id: number; snapshot: RiskSnapshot }[] = [...due];
  if (rows.length === 0) return result;

  const heads = new Map((await loadHeads(rows.map((r) => Number(r.id)))).map((h) => [h.id, h]));
  const current = await currentRisk([...new Set(rows.flatMap((r) => Object.keys(r.snapshot.buildings ?? {})))]);

  for (const row of rows) {
    const head = heads.get(Number(row.id));
    if (!head) continue;
    const snapshot = row.snapshot;
    const changes = compareRisk(snapshot, current);
    result.checked++;
    if (changes.length) result.changed++;

    if (dryRun) continue;

    if (changes.length) {
      const to = recipientOf(head);
      if (!to || !head.reference) {
        result.noRecipient++;
      } else {
        const mail = buildRiskChangedEmail({
          reference: head.reference,
          recipientName: to.name,
          changes,
          statusUrl: statusUrl(head.reference),
          replyTo: questionReplyAddress(head.reference),
        });
        // Timeline first, so the status page shows what changed even when
        // the transport fails; the send itself adds its own "gemaild" line.
        await addEntry({
          dossierId: head.id,
          kind: "status",
          actorKind: "system",
          actor: "model",
          text:
            "Funderingsrisico herberekend: " +
            changes.map((c) => `${c.address}: ${c.fields.map((f) => `${f.label} ${riskLabel(f.before)} → ${riskLabel(f.after)}`).join(", ")}`).join("; "),
          body: { changes },
          visibleToMelder: true,
        });
        if (await deliver(head, "risk_changed", to, mail)) result.mailed++;
      }
    }
    await writeSnapshot(head.id, { ...snapshot, checked_at: new Date().toISOString(), changed: changes.length > 0 });
  }
  return result;
}
