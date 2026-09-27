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
 *                   model's current row; ONE mail either way (dossier_mail
 *                   kind 'risk_changed', the one follow-up slot per dossier):
 *                   what changed, or -- API #204, Don 2026-09-22 "ik zou altijd
 *                   een bevestiging sturen, ook als het risico niet verandert,
 *                   liefst met onderbouwing" -- that nothing did, and why the
 *                   risk is what it is. The snapshot is then marked checked so
 *                   the next run leaves it alone.
 *
 * No status change, no reopening: the dossier stays closed, the timeline gets
 * a line. Windmill calls the endpoint as the last step of the refresh flow.
 */

import { sql } from "drizzle-orm";
import { inArray } from "drizzle-orm";
import { db } from "../db/client.ts";
import { dossier } from "../db/schema/dataops.ts";
import { model_risk_static } from "../db/schema/data.ts";
import { inquiry } from "../db/schema/report.ts";
import { addEntry } from "./dossier-entries.ts";
import {
  type Block,
  type ClosedAddressSummary,
  type DossierHead,
  type RegisteredRisk,
  type RenderedMail,
  addressLine,
  deliver,
  formatFieldValue,
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

/** What the model row says about why a pand's risk is what it is. */
export interface RiskBasis {
  foundationType: string | null;
  /** established · cluster · supercluster · indicative */
  foundationTypeReliability: string | null;
  /** The report the model uses for this pand, when it uses one. */
  inquiryType: string | null;
  documentName: string | null;
  documentDate: string | null;
  drystandRisk: string | null;
  /** Metres. */
  drystand: number | null;
  dewateringDepthRisk: string | null;
  /** Metres. */
  dewateringDepth: number | null;
  bioInfectionRisk: string | null;
}

const RISK_ORDER = ["a", "b", "c", "d", "e"];
const metres = (v: number) => `${v.toFixed(2).replace(".", ",")} m`;

/**
 * The onderbouwing, in plain sentences, from the model row only (API #204):
 * what the model based the pand on, the foundation type, and which part of
 * the risk is the highest -- with its measurement when there is one. Nothing
 * here is inferred beyond what the row holds; a missing value is left out,
 * never guessed. Pure; tested in intake-risk-followup.test.ts.
 */
export function explainBasis(b: RiskBasis | null): string[] {
  if (!b) return ["Voor dit pand is op dit moment geen risicoberekening beschikbaar."];
  const lines: string[] = [];
  if (b.inquiryType) {
    const year = b.documentDate?.slice(0, 4);
    const what = formatFieldValue("inquiry_type", b.inquiryType);
    lines.push(`Gebaseerd op: ${what}${b.documentName ? ` "${b.documentName}"` : ""}${year ? ` (${year})` : ""}.`);
  } else if (b.foundationTypeReliability === "cluster" || b.foundationTypeReliability === "supercluster") {
    lines.push("Voor dit pand zelf is geen funderingsonderzoek bekend; het funderingstype is afgeleid van onderzoek aan panden in de buurt.");
  } else {
    lines.push("Voor dit pand zelf is geen funderingsonderzoek bekend; het funderingstype is geschat op basis van onder meer het bouwjaar en de bodem.");
  }
  if (b.foundationType) lines.push(`Funderingstype: ${formatFieldValue("foundation_type", b.foundationType)}.`);

  const parts = [
    { risk: b.drystandRisk, label: "droogstand", measure: b.drystand },
    { risk: b.dewateringDepthRisk, label: "ontwateringsdiepte", measure: b.dewateringDepth },
    { risk: b.bioInfectionRisk, label: "bacteriële aantasting", measure: null },
  ].filter((x) => x.risk && RISK_ORDER.includes(x.risk.toLowerCase()));
  if (parts.length) {
    const worst = parts.reduce((w, x) => (RISK_ORDER.indexOf(x.risk!.toLowerCase()) > RISK_ORDER.indexOf(w.risk!.toLowerCase()) ? x : w));
    const tied = parts.filter((x) => x.risk!.toLowerCase() === worst.risk!.toLowerCase());
    const names = (xs: { label: string }[]) =>
      xs.length === 1 ? `de ${xs[0]!.label}` : `de ${xs.slice(0, -1).map((x) => x.label).join(", de ")} en de ${xs.at(-1)!.label}`;
    if (worst.risk!.toLowerCase() === "a") {
      lines.push("Geen van de onderdelen geeft een verhoogd risico.");
    } else if (tied.length === 1) {
      lines.push(`Het hoogste risico komt uit de ${worst.label}${worst.measure != null ? ` (${metres(worst.measure)})` : ""}: ${riskLabel(worst.risk)}.`);
    } else {
      lines.push(`Het hoogste risico, ${riskLabel(worst.risk)}, komt uit ${names(tied)}.`);
    }
  }
  return lines;
}

export interface RiskConfirmedEmailInput {
  reference: string;
  recipientName: string;
  buildings: { address: string; risk: RegisteredRisk | null; basis: RiskBasis | null }[];
  statusUrl: string;
  replyTo: string;
}

/**
 * The follow-up when nothing changed (API #204). It says so plainly and gives
 * the basis. It leaves out "wordt dagelijks herberekend": after "ongewijzigd"
 * that only invites "wanneer dan wel?" (Don).
 */
export function buildRiskConfirmedEmail(input: RiskConfirmedEmailInput): RenderedMail {
  const one = input.buildings.length === 1;
  const blocks: Block[] = [
    { p: `Beste ${input.recipientName || "melder"},` },
    {
      p:
        `Na de verwerking van uw melding ${input.reference} hebben wij het funderingsrisico opnieuw berekend. ` +
        `Het geregistreerde risico is ongewijzigd. Hieronder leest u waar ${one ? "het" : "het per adres"} op gebaseerd is.`,
    },
  ];
  for (const b of input.buildings) {
    const shown = b.risk
      ? [
          `droogstand: ${riskLabel(b.risk.drystand)}`,
          `ontwateringsdiepte: ${riskLabel(b.risk.dewateringDepth)}`,
          `bacteriële aantasting: ${riskLabel(b.risk.bioInfection)}`,
          ...(b.risk.unclassified ? [`vastgesteld risico: ${riskLabel(b.risk.unclassified)}`] : []),
        ]
      : [];
    blocks.push({ p: b.address }, { ul: [...shown, ...explainBasis(b.basis)] });
  }
  blocks.push(
    {
      p:
        "Klopt dit niet met wat u weet over uw pand, bijvoorbeeld omdat de fundering is hersteld of er een nieuwer onderzoek is? " +
        "Beantwoord dan deze e-mail en stuur het document mee. Uw reactie wordt automatisch aan uw melding gekoppeld.",
    },
    { p: "De status van uw melding kunt u volgen via:" },
    { url: input.statusUrl },
  );
  return render(`FunderMaps - Het funderingsrisico van uw melding ${input.reference} is ongewijzigd`, blocks);
}

export async function currentBasis(buildingIds: string[]): Promise<Map<string, RiskBasis>> {
  if (buildingIds.length === 0) return new Map();
  const rows = await db
    .select({
      buildingId: model_risk_static.building_id,
      foundationType: model_risk_static.foundation_type,
      foundationTypeReliability: model_risk_static.foundation_type_reliability,
      inquiryType: model_risk_static.inquiry_type,
      inquiryId: model_risk_static.inquiry_id,
      drystandRisk: model_risk_static.drystand_risk,
      drystand: model_risk_static.drystand,
      dewateringDepthRisk: model_risk_static.dewatering_depth_risk,
      dewateringDepth: model_risk_static.dewatering_depth,
      bioInfectionRisk: model_risk_static.bio_infection_risk,
    })
    .from(model_risk_static)
    .where(inArray(model_risk_static.building_id, buildingIds));
  const inquiryIds = [...new Set(rows.map((r) => r.inquiryId).filter((i): i is number => i != null))];
  const docs = inquiryIds.length
    ? new Map(
        (await db.select({ id: inquiry.id, name: inquiry.documentName, date: inquiry.documentDate }).from(inquiry).where(inArray(inquiry.id, inquiryIds)))
          .map((d) => [d.id, d] as const),
      )
    : new Map<number, { id: number; name: string; date: string }>();
  const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const out = new Map<string, RiskBasis>();
  for (const r of rows) {
    if (!r.buildingId) continue;
    const doc = r.inquiryId != null ? docs.get(r.inquiryId) : undefined;
    out.set(r.buildingId, {
      foundationType: r.foundationType ?? null,
      foundationTypeReliability: r.foundationTypeReliability ?? null,
      inquiryType: r.inquiryType ?? null,
      documentName: doc?.name ?? null,
      documentDate: doc?.date ?? null,
      drystandRisk: r.drystandRisk ?? null,
      drystand: num(r.drystand),
      dewateringDepthRisk: r.dewateringDepthRisk ?? null,
      dewateringDepth: num(r.dewateringDepth),
      bioInfectionRisk: r.bioInfectionRisk ?? null,
    });
  }
  return out;
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
      const main = await mainAddress(head.buildingId, head.bagId);
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
  /** Unchanged dossiers that got the confirmation with the basis (API #204). */
  confirmed: number;
  mailed: number;
  noRecipient: number;
  /** Dossiers whose check threw; logged, skipped, retried next run. */
  failed: number;
  dryRun: boolean;
}

/**
 * The run after the model refresh. Idempotent: a snapshot is checked once,
 * and dossier_mail keeps 'risk_changed' to one per dossier even if it is not.
 */
export async function sendRiskFollowups(opts: { dryRun?: boolean; limit?: number } = {}): Promise<FollowupResult> {
  const dryRun = opts.dryRun ?? false;
  const result: FollowupResult = { lastRefresh: null, checked: 0, changed: 0, confirmed: 0, mailed: 0, noRecipient: 0, failed: 0, dryRun };

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
  const buildingIds = [...new Set(rows.flatMap((r) => Object.keys(r.snapshot.buildings ?? {})))];
  const current = await currentRisk(buildingIds);
  const basis = await currentBasis(buildingIds);

  for (const row of rows) {
    const head = heads.get(Number(row.id));
    if (!head) continue;
    const snapshot = row.snapshot;
    const changes = compareRisk(snapshot, current);
    result.checked++;
    if (changes.length) result.changed++;

    if (dryRun) continue;

    // One dossier must not take the run down with it: the first live run
    // (2026-09-14 12:30) died as a whole on a missing column grant while
    // marking one snapshot checked. Log, count, move on; the snapshot stays
    // unchecked and is retried after the next refresh.
    try {
      await followUpOne(head, snapshot, changes, current, basis, result);
    } catch (err) {
      result.failed++;
      console.error(`risk follow-up for dossier ${head.id} failed:`, err);
    }
  }
  return result;
}

async function followUpOne(
  head: DossierHead,
  snapshot: RiskSnapshot,
  changes: RiskChange[],
  current: Map<string, RegisteredRisk>,
  basis: Map<string, RiskBasis>,
  result: FollowupResult,
): Promise<void> {
  {
    if (!changes.length) {
      const to = recipientOf(head);
      if (!to || !head.reference) {
        result.noRecipient++;
      } else {
        const buildings = Object.entries(snapshot.buildings).map(([id, b]) => ({
          address: b.address,
          risk: current.get(id) ?? b.risk,
          basis: basis.get(id) ?? null,
        }));
        const mail = buildRiskConfirmedEmail({
          reference: head.reference,
          recipientName: to.name,
          buildings,
          statusUrl: statusUrl(head.reference),
          replyTo: questionReplyAddress(head.reference),
        });
        await addEntry({
          dossierId: head.id,
          kind: "status",
          actorKind: "system",
          actor: "model",
          text:
            "Funderingsrisico herberekend: ongewijzigd. " +
            buildings.map((b) => `${b.address}: ${explainBasis(b.basis).join(" ")}`).join("; "),
          body: { unchanged: true, basis: buildings.map((b) => ({ address: b.address, basis: b.basis })) },
          visibleToMelder: true,
        });
        // The same once-per-dossier slot as a change: one follow-up per melding.
        if (await deliver(head, "risk_changed", to, mail)) {
          result.mailed++;
          result.confirmed++;
        }
      }
    } else {
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
}
