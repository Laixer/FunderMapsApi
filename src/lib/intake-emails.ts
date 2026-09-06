// Melder-facing notification mail for the public intake lane (tracker
// FunderMaps #1020 "Melden triage"): the ontvangstbevestiging right after the
// form, and the afronding once a reviewer has closed the dossier.
//
// Same shape as report-emails.ts: plain text is the canonical body, the HTML
// is a light wrapper around the same words. Everything that touches the
// network or the database is fail-soft -- the dossier is the record and the
// mail is a courtesy, so nothing in this module may throw into a route.
//
// Idempotency: one row in dataops.dossier_mail per (dossier, kind), claimed
// BEFORE the send. A second call for the same dossier -- an HTTP retry, a
// close followed by a commit, a bulk close that overlaps an earlier one --
// finds the row and does nothing. A send that failed leaves status 'failed'
// and is claimed again by the next call, so a Resend hiccup is not final.

import { and, asc, eq, inArray } from "drizzle-orm";
import { env } from "../config.ts";
import { db } from "../db/client.ts";
import {
  artifact,
  dossier,
  dossierMail,
  extraction,
  extractionField,
  verdict,
} from "../db/schema/dataops.ts";
import { model_risk_static } from "../db/schema/data.ts";
import { address as geocoderAddress } from "../db/schema/geocoder.ts";
import { sendMail } from "../services/mail.ts";
import { describeOutcome } from "./intake-outcome.ts";
import { addEntry } from "./dossier-entries.ts";

// ─────────────────────────────────────────────────────────────────────────
// The promise
// ─────────────────────────────────────────────────────────────────────────

/**
 * How long the melder is told to wait, in working days after the day the
 * melding arrived (Amsterdam time). Don's suggestion; the queue is worked as a
 * waiting line precisely so this can be kept. Weekends and the Dutch national
 * holidays (`isDutchPublicHoliday`) are skipped -- Don's ruling 2026-09-06.
 */
export const RESPONSE_BUSINESS_DAYS = 2;

/** The mailbox every dossier mail is sent from; replies (plus-addressed with the reference) come back via the Resend webhook. */
export const QUESTION_MAILBOX = "melding@funderdata.nl";

const TZ = "Europe/Amsterdam";

/** The calendar day of `d` in Amsterdam, as a UTC-midnight Date for arithmetic. */
export function localDay(d: Date): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const [y, m, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!));
}

/** Easter Sunday (Gregorian, Anonymous/Meeus algorithm) as a UTC-midnight Date. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function plusDays(day: Date, n: number): Date {
  const d = new Date(day.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

/**
 * The "algemeen erkende feestdagen" (rijksoverheid.nl) for a UTC-midnight
 * calendar day: Nieuwjaarsdag, Goede Vrijdag, Eerste + Tweede Paasdag,
 * Koningsdag (26 April when the 27th is a Sunday), Bevrijdingsdag (every year:
 * promising a day late beats promising a day early), Hemelvaartsdag,
 * Eerste + Tweede Pinksterdag, Eerste + Tweede Kerstdag.
 */
export function isDutchPublicHoliday(day: Date): boolean {
  const y = day.getUTCFullYear();
  const md = `${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
  if (md === "01-01" || md === "05-05" || md === "12-25" || md === "12-26") return true;
  const kingsDay = new Date(Date.UTC(y, 3, 27));
  if (kingsDay.getUTCDay() === 0) kingsDay.setUTCDate(26);
  if (day.getTime() === kingsDay.getTime()) return true;
  const easter = easterSunday(y);
  const t = day.getTime();
  return [-2, 0, 1, 39, 49, 50].some((offset) => plusDays(easter, offset).getTime() === t);
}

/** `days` working days after the Amsterdam calendar day of `from`; weekends and Dutch national holidays do not count. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = localDay(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !isDutchPublicHoliday(d)) left--;
  }
  return d;
}

/** "dinsdag 8 september 2026" for a day produced by localDay/addBusinessDays. */
export function formatDayNl(day: Date, weekday = true): string {
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: "UTC",
    ...(weekday ? { weekday: "long" } : {}),
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(day);
}

// ─────────────────────────────────────────────────────────────────────────
// Words
// ─────────────────────────────────────────────────────────────────────────

/** The intake form's file categories (FunderMapsIntake contract.ts), lower-cased for running text. */
const CATEGORY_LABEL: Record<string, string> = {
  archieveresearch: "bouwtekening / archiefstuk",
  foundationresearch: "funderingsonderzoek",
  quickscan: "QuickScan",
  herstelbewijs: "bewijs van funderingsherstel",
  foto: "foto's van de woning",
  overig: "overig",
};

/** extraction_field.field -> how the melder knows it. Mirrors the Studio's sample labels. */
const FIELD_LABEL: Record<string, string> = {
  foundation_type: "Funderingstype",
  built_year: "Bouwjaar",
  foundation_quality: "Funderingskwaliteit",
  recovery_advised: "Funderingsherstel geadviseerd",
  recovery_note: "Hersteladvies",
  follow_up_note: "Vervolgadvies",
  enforcement_term: "Handhavingstermijn",
  groundwater_level: "Grondwaterniveau bij ontgraving",
  wood_level: "Niveau bovenkant langshout",
  pile_head_level: "Paalkopniveau",
  pile_tip_level: "Paalpuntniveau",
  concrete_charger_length: "Lengte oplanger",
  pile_diameter_top: "Paalkopdiameter",
  pile_diameter_bottom: "Paalpuntdiameter",
  pile_distance_length: "Hart-op-hartafstand",
  wood_type: "Houtsoort",
  wood_penetration_depth: "Inslagdiepte",
  wood_encroachment: "Houtaantasting",
  foundation_depth: "Funderingsniveau",
  groundlevel: "Maaiveldniveau",
  damage_cause: "Schadeoorzaak",
  damage_characteristics: "Geconstateerde schade",
  crack_facade_front_type: "Scheurvorming voorgevel",
  crack_facade_back_type: "Scheurvorming achtergevel",
  crack_indoor_type: "Scheurvorming binnen",
  skewed_parallel: "Lintvoegmeting",
  skewed_perpendicular: "Scheefstand haaks op de gevel",
};

/** report.foundation_type, in words a homeowner uses. */
const FOUNDATION_TYPE_LABEL: Record<string, string> = {
  wood: "houten palen",
  wood_amsterdam: "houten palen (Amsterdamse fundering)",
  wood_rotterdam: "houten palen (Rotterdamse fundering)",
  wood_rotterdam_amsterdam: "houten palen (Rotterdamse/Amsterdamse fundering)",
  wood_rotterdam_arch: "houten palen (Rotterdamse fundering met spaarboog)",
  wood_amsterdam_arch: "houten palen (Amsterdamse fundering met spaarboog)",
  wood_charger: "houten palen met betonoplanger",
  concrete: "betonnen palen",
  steel_pile: "stalen buispalen",
  weighted_pile: "verzwaarde-puntpalen",
  no_pile: "ondiepe fundering (op staal)",
  no_pile_masonry: "ondiepe fundering, gemetseld",
  no_pile_strips: "ondiepe fundering, stroken",
  no_pile_bearing_floor: "ondiepe fundering, plaatfundering",
  no_pile_concrete_floor: "ondiepe fundering, betonvloer",
  no_pile_slit: "ondiepe fundering, slieten",
  combined: "gecombineerde fundering",
  other: "overig",
};

const ENFORCEMENT_TERM_LABEL: Record<string, string> = {
  term05: "0-5 jaar",
  term510: "5-10 jaar",
  term1020: "10-20 jaar",
  term5: "5 jaar",
  term10: "10 jaar",
  term15: "15 jaar",
  term20: "20 jaar",
  term25: "25 jaar",
  term30: "30 jaar",
  term40: "40 jaar",
};

const FOUNDATION_QUALITY_LABEL: Record<string, string> = {
  bad: "slecht",
  mediocre: "matig",
  tolerable: "redelijk",
  good: "goed",
  mediocre_good: "matig tot goed",
  mediocre_bad: "matig tot slecht",
};

const DAMAGE_CAUSE_LABEL: Record<string, string> = {
  drainage: "ontwatering",
  construction_flaw: "constructiefout",
  drystand: "droogstand",
  overcharge: "overbelasting",
  overcharge_negative_cling: "overbelasting door negatieve kleef",
  negative_cling: "negatieve kleef",
  bio_infection: "bacteriële aantasting",
  fungus_infection: "schimmelaantasting",
  bio_fungus_infection: "bacteriële aantasting en schimmelaantasting",
  foundation_flaw: "funderingsgebrek",
  construction_heave: "opbolling door de constructie",
  subsidence: "zetting",
  vegetation: "boomwortels / vegetatie",
  gas: "gaswinning",
  vibrations: "trillingen",
  partial_foundation_recovery: "gedeeltelijk funderingsherstel",
  japanese_knotweed: "Japanse duizendknoop",
  groundwater_level_reduction: "grondwaterstandverlaging",
};

const DAMAGE_CHARACTERISTICS_LABEL: Record<string, string> = {
  jamming_door_window: "klemmende deuren en ramen",
  crack: "scheurvorming",
  skewed: "scheefstand",
  crawlspace_flooding: "water in de kruipruimte",
  threshold_above_subsurface: "drempel boven het maaiveld",
  threshold_below_subsurface: "drempel onder het maaiveld",
  crooked_floor_wall: "scheve vloeren of wanden",
};

const RISK_LABEL: Record<string, string> = {
  a: "A (geen risico)",
  b: "B (laag risico)",
  c: "C (verhoogd risico)",
  d: "D (hoog risico)",
  e: "E (aanzienlijk hoog risico)",
};

const RELIABILITY_LABEL: Record<string, string> = {
  indicative: "indicatief",
  established: "vastgesteld",
  cluster: "afgeleid",
  supercluster: "afgeleid",
};

/** Levels are metres relative to NAP; the rest is shown as recorded. */
const NAP_FIELDS = new Set([
  "wood_level",
  "pile_head_level",
  "pile_tip_level",
  "groundwater_level",
  "foundation_depth",
  "groundlevel",
]);

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field.replaceAll("_", " ");
}

export function formatFieldValue(field: string, value: string): string {
  switch (field) {
    case "foundation_type":
      return FOUNDATION_TYPE_LABEL[value] ?? value.replaceAll("_", " ");
    case "recovery_advised":
      return value === "true" ? "ja" : value === "false" ? "nee" : value;
    case "enforcement_term":
      return ENFORCEMENT_TERM_LABEL[value] ?? value;
    case "foundation_quality":
      return FOUNDATION_QUALITY_LABEL[value] ?? value.replaceAll("_", " ");
    case "damage_cause":
      return DAMAGE_CAUSE_LABEL[value] ?? value.replaceAll("_", " ");
    case "damage_characteristics":
      return DAMAGE_CHARACTERISTICS_LABEL[value] ?? value.replaceAll("_", " ");
    default:
      if (NAP_FIELDS.has(field) && Number.isFinite(parseFloat(value))) return `${value} m NAP`;
      return value.replaceAll("_", " ");
  }
}

export function riskLabel(risk: string | null | undefined): string {
  if (!risk) return "niet bepaald";
  return RISK_LABEL[risk.toLowerCase()] ?? risk.toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────

export type Block =
  | { p: string }
  | { ul: string[] }
  | { url: string };

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Both bodies from one list of blocks, so the two renderings cannot drift.
 * Paragraphs, bullet lists and a bare link are all a melder mail needs.
 */
export function render(subject: string, blocks: Block[]): RenderedMail {
  const closing: Block[] = [{ p: "Met vriendelijke groet,\nFunderMaps" }];
  const all = [...blocks, ...closing];

  const text = all
    .map((b) => {
      if ("p" in b) return b.p;
      if ("ul" in b) return b.ul.map((i) => `- ${i}`).join("\n");
      return b.url;
    })
    .join("\n\n");

  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">` +
    all
      .map((b) => {
        if ("p" in b) return `<p>${escapeHtml(b.p).replaceAll("\n", "<br>")}</p>`;
        if ("ul" in b) return `<ul>${b.ul.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
        return `<p><a href="${escapeHtml(b.url)}">${escapeHtml(b.url)}</a></p>`;
      })
      .join("") +
    `</div>`;

  return { subject, text, html };
}

// ─────────────────────────────────────────────────────────────────────────
// Mail 1: ontvangstbevestiging
// ─────────────────────────────────────────────────────────────────────────

export interface ReceivedFile {
  name: string;
  category: string | null;
}

export interface ReceivedEmailInput {
  reference: string;
  recipientName: string;
  /** "Jollenpad 13, 1081 KC Amsterdam", or the BAG id when the address did not resolve. */
  address: string;
  receivedAt: Date;
  files: ReceivedFile[];
  statusUrl: string;
  replyTo: string;
}

export function buildReceivedEmail(input: ReceivedEmailInput): RenderedMail {
  const deadline = formatDayNl(addBusinessDays(input.receivedAt, RESPONSE_BUSINESS_DAYS));
  const fileLines = input.files.map((f) => {
    const cat = f.category ? CATEGORY_LABEL[f.category] ?? f.category : null;
    return cat ? `${f.name} (${cat})` : f.name;
  });

  const blocks: Block[] = [
    { p: `Beste ${input.recipientName || "melder"},` },
    {
      p:
        `Wij hebben uw melding over ${input.address} ontvangen. Uw meldcode is ${input.reference}. ` +
        `Bewaar deze code: hiermee kunt u de status van uw melding volgen en wij verwijzen ernaar in onze berichten.`,
    },
  ];

  if (fileLines.length > 0) {
    blocks.push({ p: `Ontvangen bestanden (${fileLines.length}):` }, { ul: fileLines });
  } else {
    blocks.push({ p: "U heeft geen bestanden meegestuurd." });
  }

  blocks.push(
    {
      p:
        `Wat gebeurt er nu? Een medewerker van FunderMaps beoordeelt uw melding en de meegestuurde documenten. ` +
        `Gegevens over de fundering die wij kunnen gebruiken, nemen wij over in de Funderingsdatabase. ` +
        `Zodra dat is gebeurd, krijgt u daarvan per e-mail bericht.`,
    },
    { p: `U hoort uiterlijk ${deadline} van ons.` },
    { p: "De status van uw melding kunt u volgen via:" },
    { url: input.statusUrl },
    {
      p: `Vragen over uw melding? Stuur een e-mail naar ${input.replyTo} en vermeld daarbij uw meldcode.`,
    },
  );

  return render(`FunderMaps - Uw melding ${input.reference} is ontvangen`, blocks);
}

// ─────────────────────────────────────────────────────────────────────────
// Mail 2: afronding
// ─────────────────────────────────────────────────────────────────────────

export interface TakenField {
  field: string;
  value: string;
  /**
   * What FunderMaps held for this address before the melding, for the fields
   * that have a registered counterpart (foundation type, build year). Null
   * when there is none or the model had nothing for the building.
   */
  registered: string | null;
  registeredReliability?: string | null;
  comparison: "same" | "differs" | "none";
}

export interface RegisteredRisk {
  drystand: string | null;
  dewateringDepth: string | null;
  bioInfection: string | null;
  unclassified: string | null;
}

export interface ClosedAddressSummary {
  address: string;
  fields: TakenField[];
  /** As registered at the moment of closing. Null when the model has no row for the building. */
  risk: RegisteredRisk | null;
}

export interface ClosedEmailInput {
  reference: string;
  recipientName: string;
  outcome: string;
  note: string | null;
  hasInquiry: boolean;
  addresses: ClosedAddressSummary[];
  statusUrl: string;
  replyTo: string;
}

function describeField(f: TakenField): string {
  const head = `${fieldLabel(f.field)}: ${formatFieldValue(f.field, f.value)}`;
  switch (f.comparison) {
    case "same":
      return `${head} (komt overeen met wat bij ons geregistreerd stond)`;
    case "differs": {
      const rel = f.registeredReliability ? `, ${RELIABILITY_LABEL[f.registeredReliability] ?? f.registeredReliability}` : "";
      const was = f.registered ? formatFieldValue(f.field, f.registered) : "geen gegevens";
      return `${head} (bij ons stond: ${was}${rel})`;
    }
    default:
      return head;
  }
}

function describeRisk(r: RegisteredRisk): string {
  const parts = [
    `droogstand ${riskLabel(r.drystand)}`,
    `ontwateringsdiepte ${riskLabel(r.dewateringDepth)}`,
    `bacteriële aantasting ${riskLabel(r.bioInfection)}`,
  ];
  if (r.unclassified) parts.push(`vastgesteld risico ${riskLabel(r.unclassified)}`);
  return `Funderingsrisico zoals nu bij ons geregistreerd: ${parts.join(", ")}.`;
}

export function buildClosedEmail(input: ClosedEmailInput): RenderedMail {
  const { state, explanation } = describeOutcome(input.outcome, input.note, input.hasInquiry);

  const taken = input.addresses.filter((a) => a.fields.length > 0);
  const listed = input.outcome === "accepted" && taken.length > 0;
  // The default "overgenomen" sentence only repeats the list heading below;
  // a reviewer's own note is always worth a line.
  const reviewerNote = explanation === input.note;

  const blocks: Block[] = [
    { p: `Beste ${input.recipientName || "melder"},` },
    { p: `Uw melding met meldcode ${input.reference} is ${state}.` },
    ...(listed && !reviewerNote ? [] : [{ p: explanation }]),
  ];

  if (listed) {
    blocks.push({ p: "Dit hebben wij overgenomen in de Funderingsdatabase:" });
    for (const a of taken) {
      blocks.push({ p: `${a.address}:` }, { ul: a.fields.map(describeField) });
      if (a.risk) blocks.push({ p: describeRisk(a.risk) });
    }
    const anyDiffers = taken.some((a) => a.fields.some((f) => f.comparison === "differs"));
    blocks.push({
      p:
        `Het funderingsrisico wordt dagelijks opnieuw berekend. Uw gegevens tellen vanaf de volgende berekening mee` +
        (anyDiffers
          ? `; omdat ze afwijken van wat bij ons geregistreerd stond, kan het risico daardoor veranderen.`
          : `. Het risico verandert daardoor naar verwachting niet.`),
    });
  }

  blocks.push(
    { p: "De status van uw melding kunt u teruglezen via:" },
    { url: input.statusUrl },
    {
      p: `Vragen over deze afhandeling? Stuur een e-mail naar ${input.replyTo} en vermeld daarbij uw meldcode.`,
    },
  );

  return render(`FunderMaps - Uw melding ${input.reference} is ${state}`, blocks);
}

// ─────────────────────────────────────────────────────────────────────────
// Delivery, with the send log
// ─────────────────────────────────────────────────────────────────────────

type MailKind = "received" | "closed";

export interface DossierHead {
  id: number;
  reference: string | null;
  buildingId: string | null;
  bagId: string | null;
  receivedAt: Date;
  submitter: Record<string, unknown> | null;
  outcome: string | null;
  outcomeNote: string | null;
  inquiryId: number | null;
}

export interface Recipient {
  email: string;
  name: string;
}

/** Who to write to, or null when the dossier has nobody (bulk drops, no email). */
function recipientOf(head: DossierHead): Recipient | null {
  if (!head.reference) return null;
  const email = typeof head.submitter?.email === "string" ? head.submitter.email.trim() : "";
  if (!email.includes("@")) return null;
  const name = typeof head.submitter?.name === "string" ? head.submitter.name.trim() : "";
  return { email, name };
}

function statusUrl(reference: string): string {
  return `${env.INTAKE_URL}/melding/${encodeURIComponent(reference)}`;
}

/** "Jollenpad 13, 1081 KC Amsterdam". geocoder.address stores the postal code without its space. */
export function addressLine(a: {
  street: string;
  buildingNumber: string;
  postalCode: string | null;
  city: string;
}): string {
  const postal = a.postalCode?.replace(/^(\d{4})\s?([A-Za-z]{2})$/, "$1 $2") ?? null;
  const line1 = [a.street, a.buildingNumber].filter(Boolean).join(" ");
  const line2 = [postal, a.city].filter(Boolean).join(" ");
  return [line1, line2].filter(Boolean).join(", ");
}

/**
 * The name the melder gave the file. Early intake uploads prefixed the
 * original name with a 16-hex storage nonce (same strip as the commit's
 * documentName); the melder never saw that part.
 */
export function displayFilename(name: string | null): string {
  return (name ?? "").replace(/^[0-9a-f]{16}-/, "") || "bestand";
}

const addressColumns = {
  id: geocoderAddress.id,
  buildingId: geocoderAddress.buildingId,
  street: geocoderAddress.street,
  buildingNumber: geocoderAddress.buildingNumber,
  postalCode: geocoderAddress.postalCode,
  city: geocoderAddress.city,
};

/** The address the status page shows for the dossier's building. */
async function mainAddress(buildingId: string | null) {
  if (!buildingId) return null;
  const [row] = await db
    .select(addressColumns)
    .from(geocoderAddress)
    .where(eq(geocoderAddress.buildingId, buildingId))
    .orderBy(asc(geocoderAddress.id))
    .limit(1);
  return row ?? null;
}

/**
 * Claim the (dossier, kind) slot. Returns the log row id when this call owns
 * the send, null when an earlier call already did (or is doing it right now).
 * A 'failed' row is re-claimed so a transport error is not the last word.
 */
async function claim(dossierId: number, kind: MailKind, recipient: string, subject: string) {
  const rows = await db
    .insert(dossierMail)
    .values({ dossierId, kind, recipient, subject })
    .onConflictDoUpdate({
      target: [dossierMail.dossierId, dossierMail.kind],
      // The unique guard is partial since 'question' mails became repeatable;
      // the arbiter must name the index predicate to keep matching it.
      targetWhere: inArray(dossierMail.kind, ["received", "closed"]),
      set: { recipient, subject, status: "pending", error: null, createdAt: new Date() },
      setWhere: eq(dossierMail.status, "failed"),
    })
    .returning({ id: dossierMail.id });
  return rows[0]?.id ?? null;
}

async function deliver(head: DossierHead, kind: MailKind, to: Recipient, mail: RenderedMail) {
  const logId = await claim(head.id, kind, to.email, mail.subject);
  if (logId === null) {
    console.info(`intake mail (${kind}) for dossier ${head.id} already sent, skipping`);
    return;
  }

  const result = await sendMail({
    to: [to.name ? `${to.name} <${to.email}>` : to.email],
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    from: `FunderMaps <${QUESTION_MAILBOX}>`,
    replyTo: questionReplyAddress(head.reference!),
  });

  await db
    .update(dossierMail)
    .set(
      result.ok
        ? { status: "sent", providerId: result.id ?? null, error: null, sentAt: new Date() }
        : { status: "failed", error: result.error ?? "unknown", sentAt: null },
    )
    .where(eq(dossierMail.id, logId));

  if (result.ok) {
    await addEntry({
      dossierId: head.id,
      kind: "status",
      actorKind: "system",
      actor: "resend",
      text: kind === "received" ? "Ontvangstbevestiging gemaild" : "Uitkomst gemaild",
      visibleToMelder: true,
      mailMessageId: result.id ?? null,
    });
  }
}

async function loadHeads(ids: number[]): Promise<DossierHead[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: dossier.id,
      reference: dossier.reference,
      buildingId: dossier.buildingId,
      bagId: dossier.bagId,
      receivedAt: dossier.receivedAt,
      submitter: dossier.submitter,
      outcome: dossier.outcome,
      outcomeNote: dossier.outcomeNote,
      inquiryId: dossier.inquiryId,
    })
    .from(dossier)
    .where(inArray(dossier.id, ids));
}

/** A mail ready to go, with who it is for. Null when the dossier has nobody to write to. */
export interface PreparedMail {
  head: DossierHead;
  to: Recipient;
  mail: RenderedMail;
}

/**
 * Build the ontvangstbevestiging for a dossier without sending or logging
 * anything. Exported so the mail can be previewed (a smoke test, or later the
 * review screen's "stuur terugkoppeling" with editable text).
 */
export async function prepareReceivedMail(head: DossierHead): Promise<PreparedMail | null> {
  const to = recipientOf(head);
  if (!to) return null;

  const files = await db
    .select({ name: artifact.originalFilename, category: artifact.declaredCategory })
    .from(artifact)
    .where(eq(artifact.dossierId, head.id))
    .orderBy(asc(artifact.id));
  const main = await mainAddress(head.buildingId);

  const mail = buildReceivedEmail({
    reference: head.reference!,
    recipientName: to.name,
    address: main ? addressLine(main) : head.bagId ?? "uw pand",
    receivedAt: head.receivedAt,
    files: files.map((f) => ({ name: displayFilename(f.name), category: f.category })),
    statusUrl: statusUrl(head.reference!),
    replyTo: questionReplyAddress(head.reference!),
  });
  return { head, to, mail };
}

/**
 * Moment 1: the receipt. Call once the dossier transaction has committed.
 * Never throws.
 */
export async function sendDossierReceivedMail(dossierId: number): Promise<void> {
  try {
    const [head] = await loadHeads([dossierId]);
    if (!head) return;
    const prepared = await prepareReceivedMail(head);
    if (!prepared) return;
    await deliver(head, "received", prepared.to, prepared.mail);
  } catch (err) {
    console.error(`intake mail (received) for dossier ${dossierId} failed:`, err);
  }
}

/**
 * What the reviewer confirmed or corrected, grouped by the address it was
 * about, against what the model held for that building. The same set of
 * values the commit writes to report.inquiry_sample, so the mail and the
 * database agree on "overgenomen".
 */
async function summarizeTaken(head: DossierHead): Promise<ClosedAddressSummary[]> {
  const judged = await db
    .select({
      fieldId: extractionField.id,
      field: extractionField.field,
      value: extractionField.value,
      addressId: extractionField.addressId,
      addressText: extractionField.addressText,
      outcome: verdict.outcome,
      finalValue: verdict.finalValue,
    })
    .from(extractionField)
    .innerJoin(extraction, eq(extraction.id, extractionField.extractionId))
    .innerJoin(artifact, eq(artifact.id, extraction.artifactId))
    .innerJoin(verdict, eq(verdict.extractionFieldId, extractionField.id))
    .where(and(eq(artifact.dossierId, head.id), inArray(verdict.outcome, ["confirmed", "corrected"])))
    .orderBy(asc(verdict.decidedAt));

  // Latest verdict per field wins; values not tied to a resolvable address
  // were kept in the inquiry note, not taken over, so they are not claimed here.
  const latest = new Map<number, (typeof judged)[number]>();
  for (const j of judged) latest.set(j.fieldId, j);
  const groups = new Map<string, { field: string; value: string }[]>();
  for (const j of latest.values()) {
    const value = (j.outcome === "corrected" ? j.finalValue : j.value) ?? "";
    if (!value) continue;
    if (j.addressText && !j.addressId) continue;
    const key = j.addressId ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ field: j.field, value });
  }
  if (groups.size === 0) return [];

  const addressIds = [...groups.keys()].filter(Boolean);
  const [rows, main] = await Promise.all([
    addressIds.length
      ? db.select(addressColumns).from(geocoderAddress).where(inArray(geocoderAddress.id, addressIds))
      : Promise.resolve([]),
    mainAddress(head.buildingId),
  ]);
  const byAddress = new Map(rows.map((r) => [r.id, r]));

  const buildingIds = [...new Set([...rows.map((r) => r.buildingId), main?.buildingId, head.buildingId].filter((b): b is string => !!b))];
  const registered = buildingIds.length
    ? await db
        .select({
          buildingId: model_risk_static.building_id,
          foundationType: model_risk_static.foundation_type,
          foundationTypeReliability: model_risk_static.foundation_type_reliability,
          constructionYear: model_risk_static.construction_year,
          drystandRisk: model_risk_static.drystand_risk,
          dewateringDepthRisk: model_risk_static.dewatering_depth_risk,
          bioInfectionRisk: model_risk_static.bio_infection_risk,
          unclassifiedRisk: model_risk_static.unclassified_risk,
        })
        .from(model_risk_static)
        .where(inArray(model_risk_static.building_id, buildingIds))
    : [];
  const byBuilding = new Map(registered.map((r) => [r.buildingId, r]));

  const out: ClosedAddressSummary[] = [];
  for (const [key, fields] of groups) {
    const addr = key ? byAddress.get(key) : main;
    const buildingId = addr?.buildingId ?? head.buildingId;
    const reg = buildingId ? byBuilding.get(buildingId) : undefined;
    const label = addr ? addressLine(addr) : head.bagId ?? "uw pand";

    out.push({
      address: label,
      fields: fields.map((f) => compareWithRegistered(f, reg)),
      risk: reg
        ? {
            drystand: reg.drystandRisk,
            dewateringDepth: reg.dewateringDepthRisk,
            bioInfection: reg.bioInfectionRisk,
            unclassified: reg.unclassifiedRisk,
          }
        : null,
    });
  }
  return out;
}

export function compareWithRegistered(
  f: { field: string; value: string },
  reg:
    | {
        foundationType: string | null;
        foundationTypeReliability: string | null;
        constructionYear: number | null;
      }
    | undefined,
): TakenField {
  const none: TakenField = { ...f, registered: null, comparison: "none" };
  if (!reg) return none;
  switch (f.field) {
    case "foundation_type": {
      const was = reg.foundationType;
      if (!was) return { ...f, registered: null, comparison: "differs" };
      return {
        ...f,
        registered: was,
        registeredReliability: reg.foundationTypeReliability,
        comparison: was === f.value ? "same" : "differs",
      };
    }
    case "built_year": {
      const was = reg.constructionYear;
      if (was === null || was === undefined) return { ...f, registered: null, comparison: "differs" };
      return { ...f, registered: String(was), comparison: String(was) === f.value ? "same" : "differs" };
    }
    default:
      return none;
  }
}

/**
 * Moment 3: the outcome. Call once the close or commit transaction has
 * committed. Dossiers without a reference or a submitter email (bulk drops)
 * are skipped before anything is looked up. Never throws.
 */
export async function sendDossierClosedMail(dossierIds: number[]): Promise<void> {
  let heads: DossierHead[] = [];
  try {
    heads = await loadHeads(dossierIds);
  } catch (err) {
    console.error(`intake mail (closed) lookup for dossiers ${dossierIds.join(",")} failed:`, err);
    return;
  }

  for (const head of heads) {
    try {
      const prepared = await prepareClosedMail(head);
      if (!prepared) continue;
      await deliver(head, "closed", prepared.to, prepared.mail);
    } catch (err) {
      console.error(`intake mail (closed) for dossier ${head.id} failed:`, err);
    }
  }
}

/** The afronding for a closed dossier, built but not sent. Null when there is no outcome or nobody to tell. */
export async function prepareClosedMail(head: DossierHead): Promise<PreparedMail | null> {
  const to = recipientOf(head);
  if (!to || !head.outcome) return null;

  const addresses = head.outcome === "accepted" ? await summarizeTaken(head) : [];
  const mail = buildClosedEmail({
    reference: head.reference!,
    recipientName: to.name,
    outcome: head.outcome,
    note: head.outcomeNote,
    hasInquiry: head.inquiryId !== null,
    addresses,
    statusUrl: statusUrl(head.reference!),
    replyTo: questionReplyAddress(head.reference!),
  });
  return { head, to, mail };
}

/** Dossier heads by id, for callers that preview. */
export async function loadDossierHeads(ids: number[]): Promise<DossierHead[]> {
  return loadHeads(ids);
}

// ─────────────────────────────────────────────────────────────────────────
// A question from the reviewer (docs/dataops-pipeline.md §11)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The mailbox questions go out from and come back to. The plus suffix carries
 * the dossier reference, so the inbound webhook can route a reply even when
 * the subject line got mangled (routes/webhooks.ts reads it back).
 */

export function questionReplyAddress(reference: string): string {
  const [box, domain] = QUESTION_MAILBOX.split("@");
  return `${box}+${reference}@${domain}`;
}

export interface QuestionMailResult {
  ok: boolean;
  /** Resend message id when sent. */
  id?: string;
  error?: string;
  recipient: string;
}

/**
 * Mail one reviewer question to the melder. NOT fail-soft, unlike the two
 * courtesy mails above: here the mail IS the action, so the caller must learn
 * whether it went out and tell the reviewer when it did not. Repeatable by
 * design -- a dossier can carry any number of questions, each its own
 * dossier_mail row.
 */
export async function sendDossierQuestionMail(
  head: DossierHead,
  question: string,
): Promise<QuestionMailResult> {
  const to = recipientOf(head);
  if (!to) return { ok: false, error: "dossier has no melder email", recipient: "" };
  const reference = head.reference!;

  const subject = `Vraag over uw melding ${reference}`;
  const mail = render(subject, [
    { p: `Beste ${to.name || "melder"},` },
    { p: `Bij de behandeling van uw melding ${reference} hebben wij een vraag:` },
    { p: question },
    { p: "U kunt deze e-mail direct beantwoorden; uw antwoord wordt aan het dossier toegevoegd." },
    { p: "De actuele stand van uw melding vindt u op:" },
    { url: statusUrl(reference) },
  ]);

  const [log] = await db
    .insert(dossierMail)
    .values({ dossierId: head.id, kind: "question", recipient: to.email, subject })
    .returning({ id: dossierMail.id });

  const result = await sendMail({
    to: [to.name ? `${to.name} <${to.email}>` : to.email],
    subject,
    text: mail.text,
    html: mail.html,
    from: `FunderMaps <${QUESTION_MAILBOX}>`,
    replyTo: questionReplyAddress(reference),
  });

  await db
    .update(dossierMail)
    .set(
      result.ok
        ? { status: "sent", providerId: result.id ?? null, error: null, sentAt: new Date() }
        : { status: "failed", error: result.error ?? "unknown", sentAt: null },
    )
    .where(eq(dossierMail.id, log!.id));

  return { ok: result.ok, id: result.id, error: result.error, recipient: to.email };
}
