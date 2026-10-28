// Queue definitions shared by the review queue (routes/dataops.ts) and the
// dispatcher (lib/dispatch-run.ts, #277), so "open", "a question" and "the
// melder had the last word" mean the same thing on both. Moved here as-is
// from routes/dataops.ts on 2026-10-28.
import { and, isNull, sql } from "drizzle-orm";
import { artifact, dossier, dossierEntry, extraction, extractionField } from "../db/schema/dataops.ts";

/** On the desk: not committed into a rapportage and not closed. */
export const onDesk = () => and(isNull(dossier.inquiryId), isNull(dossier.outcome));

/** How many files the dossier holds. 0 = a question without a document (the queue's `state=question`). */
export const fileCount = sql<number>`(
  select count(*)::int from ${artifact} a where a.dossier_id = "dataops"."dossier"."id"
)`;

/**
 * What kind of document the pipeline read this to be -- the `inquiry_type`
 * proposal (vision.DOCUMENT_FIELDS, 2026-09-07), latest reading first. Null
 * until read, or when the model could not tell. The queue's "Soort" column and
 * its `kind` filter: "toon alle QuickScans" is a question a reviewer asks.
 */
export const readKind = sql<string | null>`(
  select f.value
  from ${extractionField} f
  join ${extraction} e on e.id = f.extraction_id
  join ${artifact} a on a.id = e.artifact_id
  where a.dossier_id = "dataops"."dossier"."id"
    and f.field = 'inquiry_type' and f.state <> 'superseded'
  order by f.id desc
  limit 1
)`;

/**
 * The melder had the last word: a 'reply' entry newer than anything we did
 * on the dossier since -- a question or afronding sent, a status, or a
 * reviewer's notitie. The notitie counts on purpose (Don, 2026-09-16): a
 * reply answered from someone's own mailbox leaves no mail on the dossier,
 * and "per mail beantwoord" as a notitie is how that gets recorded. Open or
 * closed -- a reply after the afronding is exactly the case nobody saw
 * (FM2026-000107).
 */
export const melderRepliedLast = sql<boolean>`exists (
  select 1 from ${dossierEntry} r
  where r.dossier_id = "dataops"."dossier"."id" and r.kind = 'reply'
    and r.at > coalesce((
      select max(o.at) from ${dossierEntry} o
      where o.dossier_id = "dataops"."dossier"."id"
        and o.kind in ('question', 'status', 'remark') and o.actor_kind in ('reviewer', 'system')
        -- A hand-over (API #222) is not an answer to the melder.
        and o.body -> 'assignment' is null), '-infinity'::timestamptz))`;

/** report.inquiry_type codes the queue's `kind` filter accepts. */
export const KINDS = new Set([
  "monitoring", "note", "quickscan", "unknown", "demolition_research", "second_opinion",
  "archive_research", "architectural_research", "foundation_advice", "inspectionpit",
  "foundation_research", "additional_research", "ground_water_level_research", "soil_investigation",
  // The current QuickScan (the Studio offers it as "QuickScan (addendum)"). Missing
  // here, that filter answered 400 "unknown kind" and the list showed an error.
  "facade_scan",
]);
