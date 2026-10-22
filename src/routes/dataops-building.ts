import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.ts";
import { NotFoundError } from "../lib/errors.ts";
import { modelChangesFor, type RecalcRow } from "../lib/building-story.ts";
import { resolveToBuildingId } from "../services/geocoder.ts";
import type { AppEnv } from "../types/context.ts";

/**
 * GET /dataops/building/:id — one pand's whole story, for the Studio's Pand
 * page (2026-10-22): the pand and its addresses, what the model says about it
 * now, and everything that happened to it — rapportages (through the samples
 * on its addresses), recoveries, old meldingen, dossiers, and the model
 * recalculations that moved it (lib/building-story.ts).
 *
 * `:id` is a BAG pand or nummeraanduiding id (resolveToBuildingId). Not the
 * product routes: those count towards a customer's bill (product_tracker).
 * Read-only, staff-only like the rest of /api/dataops.
 */
const routes = new Hono<AppEnv>();

const rows = <T>(r: unknown) => r as T[];
/** ISO 8601 (to_json), which every browser parses. */
const iso = (col: SQL) => sql`to_json(${col}) #>> '{}'`;
/** A big block has hundreds of addresses; the page lists this many and says how many more. */
const ADDRESS_LIMIT = 50;

routes.get("/building/:id", async (c) => {
  const id = await resolveToBuildingId(c.req.param("id"));

  const [building, addresses, model, rapportages, recoveries, incidents, dossiers, recalcs] = await Promise.all([
    db.execute(sql`
      SELECT b.external_id AS id, extract(year FROM b.built_year)::int AS "builtYear", b.building_type::text AS "buildingType",
        b.active,
        round(public.ST_Y(public.ST_Centroid(b.geom))::numeric, 6)::float AS lat,
        round(public.ST_X(public.ST_Centroid(b.geom))::numeric, 6)::float AS lon,
        public.ST_AsGeoJSON(b.geom, 6)::json AS outline,
        n.name AS neighborhood, di.name AS district, m.name AS municipality, m.external_id AS "municipalityCode"
      FROM geocoder.building b
      LEFT JOIN geocoder.neighborhood n ON n.id = b.neighborhood_id
      LEFT JOIN geocoder.district di ON di.id = n.district_id
      LEFT JOIN geocoder.municipality m ON m.id = di.municipality_id
      WHERE b.external_id = ${id}
      LIMIT 1
    `),
    db.execute(sql`
      SELECT a.external_id AS id, a.street, a.building_number AS number, a.postal_code AS "postalCode", a.city,
        count(*) OVER ()::int AS total
      FROM geocoder.address a
      WHERE a.building_id = ${id}
      ORDER BY a.street, length(a.building_number), a.building_number
      LIMIT ${ADDRESS_LIMIT}
    `),
    db.execute(sql`
      SELECT foundation_type::text AS "foundationType", foundation_type_reliability::text AS "foundationTypeReliability",
        construction_year AS "constructionYear", construction_year_reliability::text AS "constructionYearReliability",
        drystand_risk::text AS "drystandRisk", drystand_risk_reliability::text AS "drystandRiskReliability",
        dewatering_depth_risk::text AS "dewateringDepthRisk", dewatering_depth_risk_reliability::text AS "dewateringDepthRiskReliability",
        bio_infection_risk::text AS "bioInfectionRisk", bio_infection_risk_reliability::text AS "bioInfectionRiskReliability",
        unclassified_risk::text AS "unclassifiedRisk",
        inquiry_id AS "inquiryId", inquiry_type::text AS "inquiryType", recovery_type::text AS "recoveryType",
        overall_quality::text AS "overallQuality", damage_cause::text AS "damageCause", enforcement_term::float AS "enforcementTerm",
        restoration_costs AS "restorationCosts", velocity::float AS velocity, ground_water_level::float AS "groundWaterLevel",
        ground_level::float AS "groundLevel", height::float AS height, surface_area::float AS "surfaceArea", soil
      FROM data.model_risk_static
      WHERE building_id = ${id}
      LIMIT 1
    `),
    db.execute(sql`
      SELECT i.id, i.type::text AS type, i.document_name AS "documentName", i.document_date::text AS "documentDate",
        i.audit_status::text AS "auditStatus", ${iso(sql`i.create_date`)} AS "createdAt", ct.name AS contractor,
        count(s.id)::int AS samples,
        array_agg(DISTINCT concat_ws(' ', a.street, a.building_number)) AS addresses,
        (array_agg(s.foundation_type::text ORDER BY s.id) FILTER (WHERE s.foundation_type IS NOT NULL))[1] AS "foundationType",
        (array_agg(s.overall_quality::text ORDER BY s.id) FILTER (WHERE s.overall_quality IS NOT NULL))[1] AS "overallQuality",
        (array_agg(s.damage_cause::text ORDER BY s.id) FILTER (WHERE s.damage_cause IS NOT NULL))[1] AS "damageCause",
        (array_agg(s.enforcement_term::text ORDER BY s.id) FILTER (WHERE s.enforcement_term IS NOT NULL))[1] AS "enforcementTerm",
        coalesce(bool_or(s.recovery_advised), false) AS "recoveryAdvised"
      FROM report.inquiry_sample s
      JOIN geocoder.address a ON a.external_id = s.address
      JOIN report.inquiry i ON i.id = s.inquiry_id
      LEFT JOIN application.attribution att ON att.id = i.attribution_id
      LEFT JOIN application.contractor ct ON ct.id = att.contractor_id
      WHERE a.building_id = ${id} AND s.delete_date IS NULL AND i.delete_date IS NULL
      GROUP BY i.id, ct.name
      ORDER BY i.document_date DESC NULLS LAST, i.id DESC
    `),
    db.execute(sql`
      SELECT r.id, r.type::text AS "documentType", r.document_name AS "documentName", r.document_date::text AS "documentDate",
        r.audit_status::text AS "auditStatus", ${iso(sql`r.create_date`)} AS "createdAt",
        rs.status::text AS status, rs.type::text AS "recoveryType", rs.pile_type::text AS "pileType",
        rs.recovery_date::text AS "recoveryDate", ct.name AS contractor
      FROM report.recovery_sample rs
      JOIN report.recovery r ON r.id = rs.recovery_id
      LEFT JOIN application.contractor ct ON ct.id = rs.contractor_id
      WHERE rs.building_id = ${id} AND rs.delete_date IS NULL AND r.delete_date IS NULL
      ORDER BY coalesce(rs.recovery_date, r.document_date) DESC NULLS LAST, r.id DESC
    `),
    db.execute(sql`
      SELECT i.id, ${iso(sql`i.create_date`)} AS "createdAt", i.question_type::text AS "questionType",
        i.audit_status::text AS "auditStatus", i.foundation_damage_cause::text AS "damageCause"
      FROM report.incident i
      WHERE i.building_id = ${id} AND i.delete_date IS NULL
      ORDER BY i.create_date DESC
    `),
    db.execute(sql`
      SELECT d.id::int AS id, d.reference, d.channel::text AS channel, d.subject,
        ${iso(sql`d.received_at`)} AS "receivedAt", d.outcome::text AS outcome, ${iso(sql`d.outcome_at`)} AS "outcomeAt",
        d.inquiry_id AS "inquiryId", d.recovery_id AS "recoveryId", d.audit_inquiry_id AS "auditInquiryId",
        d.duplicate_of::int AS "duplicateOf"
      FROM dataops.dossier d
      WHERE d.building_id = ${id}
      ORDER BY d.received_at DESC, d.id DESC
    `),
    db.execute(sql`
      SELECT e.dossier_id::int AS "dossierId", ${iso(sql`e.at`)} AS at, e.body
      FROM dataops.dossier_entry e
      WHERE e.text LIKE 'Funderingsrisico herberekend%'
        AND e.body->'changes' @> jsonb_build_array(jsonb_build_object('buildingId', ${id}::text))
    `),
  ]);

  const pand = rows<Record<string, unknown>>(building)[0];
  const dossierList = rows(dossiers);
  if (!pand && !dossierList.length) throw new NotFoundError("Building not found");

  type Address = { id: string; street: string; number: string; postalCode: string; city: string; total: number };
  const addressList = rows<Address>(addresses);
  return c.json({
    id,
    building: pand ?? null,
    addresses: addressList.map(({ total: _total, ...a }) => a),
    addressCount: addressList[0]?.total ?? 0,
    model: rows(model)[0] ?? null,
    rapportages: rows(rapportages),
    recoveries: rows(recoveries),
    incidents: rows(incidents),
    dossiers: dossierList,
    modelChanges: modelChangesFor(rows<RecalcRow>(recalcs), id),
  });
});

export default routes;
