import {
  pgSchema,
  text,
  integer,
  bigint,
  numeric,
  boolean,
  timestamp,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * The Data Ops intake schema.
 *
 * A document arrives, the pipeline reads what it can, and every value it
 * proposes waits here for a person. Nothing in this schema reaches a customer:
 * a proposal only becomes real when a reviewer accepts it and it is written
 * into `report.inquiry_sample` through the normal path.
 *
 * Owned by FunderMapsWorker (sql/migrate/create_dataops_ingest.sql). The API
 * reads it to build the review queue and writes only `verdict`.
 */
export const dataopsSchema = pgSchema("dataops");

export const dossier = dataopsSchema.table("dossier", {
  id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  channel: text().notNull(),
  subject: text(),
  externalRef: text("external_ref"),
  /** Same submission arriving twice through different senders. Structural, not an error. */
  duplicateOf: bigint("duplicate_of", { mode: "number" }),
  /** Set once a reviewer has committed this dossier into the report schema. */
  inquiryId: integer("inquiry_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),

  // The public form (FunderMapsIntake). Null on everything that arrived by
  // bulk drop, which is all 891 dossiers as of 2026-08-25.

  /** Melder-facing code, `FM2026-000042`. Sequential — never treat as a credential. */
  reference: text(),
  /** BAG nummeraanduiding exactly as supplied, before resolution. */
  bagId: text("bag_id"),
  /** `NL.IMBAG.PAND.*`, resolved from `bagId`. */
  buildingId: text("building_id"),
  resolutionStatus: text("resolution_status"),
  /** Contact details. Personal data — its own column so erasure can find it. */
  submitter: jsonb().$type<Record<string, unknown>>(),
  /** What the melder claims: topic, answers, form version, provenance. */
  payload: jsonb().$type<Record<string, unknown>>(),
  /** Dossier-level decision. Per-value decisions live in `verdict`. */
  outcome: text(),
  outcomeNote: text("outcome_note"),
  outcomeAt: timestamp("outcome_at", { withTimezone: true }),
});

export const artifact = dataopsSchema.table("artifact", {
  id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  dossierId: bigint("dossier_id", { mode: "number" }).notNull(),
  parentArtifactId: bigint("parent_artifact_id", { mode: "number" }),
  /** Key in the Spaces bucket. The bytes never enter Postgres. */
  storageKey: text("storage_key").notNull(),
  originalFilename: text("original_filename"),
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  pageCount: integer("page_count"),
  lane: text().notNull(),
  /**
   * What the sender said this document is, in the intake form's vocabulary.
   * A claim, never a finding: it bounds what the pipeline may conclude — a
   * `quickscan` cannot establish a foundation type, because the type in one is
   * FunderMaps data coming back to us — but classification still reads the file.
   */
  declaredCategory: text("declared_category"),
  /**
   * Text the preparer added on top of the source -- a cover sheet, or typed
   * lines above a scan. Withheld from every model; kept because on historical
   * documents it is the training label.
   */
  annotationText: text("annotation_text"),
  annotationPages: integer("annotation_pages").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const artifactPage = dataopsSchema.table("artifact_page", {
  artifactId: bigint("artifact_id", { mode: "number" }).notNull(),
  pageNo: integer("page_no").notNull(),
  /** drawing · archive_document · report · photo · map · blank · other */
  material: text(),
  materialConf: numeric("material_conf", { precision: 4, scale: 3 }),
  isClean: boolean("is_clean").notNull(),
  redactedBoxes: integer("redacted_boxes").notNull(),
  textChars: integer("text_chars"),
});

export const extraction = dataopsSchema.table("extraction", {
  id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  artifactId: bigint("artifact_id", { mode: "number" }).notNull(),
  model: text().notNull(),
  promptVersion: text("prompt_version").notNull(),
  lane: text().notNull(),
  pagesSent: integer("pages_sent"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text(),
});

export const extractionField = dataopsSchema.table("extraction_field", {
  id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  extractionId: bigint("extraction_id", { mode: "number" }).notNull(),
  /** Column name in report.inquiry_sample, so an accepted value writes straight through. */
  field: text().notNull(),
  value: text(),
  confidence: numeric({ precision: 4, scale: 3 }),
  /**
   * The passage the value came from. Required before anything auto-accepts:
   * fabrications are rare, silent, and otherwise indistinguishable from
   * correct answers. Prefixed "afgeleid:" when the model reasoned rather than
   * read, and with a Dutch refusal when the source was not admissible.
   */
  evidence: text(),
  evidencePage: integer("evidence_page"),
  /** pending · auto_accepted · confirmed · corrected · rejected · superseded */
  state: text().notNull(),
});

export const verdict = dataopsSchema.table("verdict", {
  id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  extractionFieldId: bigint("extraction_field_id", { mode: "number" }).notNull(),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  outcome: text().notNull(),
  /**
   * What the reviewer put instead. With outcome 'corrected' this pair --
   * proposed against final, on a known document -- is the training example the
   * cover-sheet era used to give us for free, and will stop giving us once the
   * pipeline reads documents instead of people.
   */
  finalValue: text("final_value"),
  note: text(),
  /** Seconds spent. The business case is invoerder time saved; it has to be measured. */
  reviewSeconds: integer("review_seconds"),
});
