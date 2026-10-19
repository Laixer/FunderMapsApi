-- FunderMaps report, FRONT HALF (cover band, Samenvatting, Hoe leest u dit rapport?, Pand, Locatie, Bouwjaar):
-- every value these sections print, as ONE JSON object, read-only (SELECT only, no product_tracker row).
--
-- Every '__PAND__' is the pand id: report-pdf/data.ts binds it as a query parameter (it is never pasted into
-- the text).
--
-- Each key mirrors one API answer the Vue report (FunderMapsReport src/services/api/building.ts) asks for, with the
-- API's own SQL (FunderMapsApi origin/main 275339e):
--   building_info   GET /api/geocoder/building-info/:id   src/routes/geocoder.ts:28-88   (public route)
--   analysis        GET /api/product/:id/analysis         src/routes/product.ts:158-211  (+ billing row: NOT here)
--   statistics      GET /api/product/:id/statistics       src/routes/product.ts:44-156   (+ billing row: NOT here)
--                   only construction_year_distribution (product.ts:82-87); the rest of /statistics is for the
--                   back half of the report. neighborhood_id/municipality_id: the hierarchy query product.ts:49-56.
--   report          GET /api/report/:id                   src/routes/report.ts:14-119
--                   only the columns the front half reads (Pand: Onderbouw; Locatie: the sample block). The
--                   attribution JOIN is kept because it is an inner join in the API (an inquiry without an
--                   attribution row does not reach the report); its names/e-mails are left out on purpose.
--   derived         NOT an API answer: the picks the Vue code makes from `report`, done here so Typst does not
--                   have to (see spec/pand.md and spec/locatie.md). Order = the Vue sort, getCombinedInquiryDataByBuildingId
--                   (src/store/building/inquiries.ts): document_date DESC (missing last), inquiry id DESC; samples
--                   of one inquiry in API order. The API query has no ORDER BY (report.ts:66-69); it runs as an index
--                   scan on inquiry_sample(building_id), which returns equal keys in heap order, i.e. ctid order
--                   (checked 2026-10-18: ctid order = the order of the API answer cached for the 10-14 PDF).
--                   `api_order` below is that position.
--
-- Types: postgres.js sends numeric and bigint as strings ("12.99", "291"); json_build_object sends them as JSON
-- numbers with the same digits. Enums are their PG labels (snake_case), as in the API.
-- The Vue report shows NO PDF at all when building_info, analysis or the statistics hierarchy is missing (the page
-- never sets data-pdf-ready); `missing` lists which of the three are absent so the Typst side can refuse the same way.
with
-- geocoder.ts:32-82, verbatim (only the bind parameter is a literal here)
bi as (
  SELECT
    b.external_id AS building_id,
    public.ST_Y(r.geom) AS residence_lat,
    public.ST_X(r.geom) AS residence_lon,
    public.ST_Y(public.ST_Centroid(b.geom)) AS building_lat,
    public.ST_X(public.ST_Centroid(b.geom)) AS building_lon,
    a.external_id AS address_id,
    a.external_id AS address_external_id,
    a.street,
    a.building_number,
    a.postal_code,
    a.city,
    n.id AS neighborhood_id,
    n.external_id AS neighborhood_external_id,
    n.name AS neighborhood_name,
    d.id AS district_id,
    d.external_id AS district_external_id,
    d.name AS district_name,
    m.id AS municipality_id,
    m.external_id AS municipality_external_id,
    m.name AS municipality_name,
    s.id AS state_id,
    s.external_id AS state_external_id,
    s.name AS state_name
  FROM geocoder.building b
  LEFT JOIN LATERAL (
    SELECT external_id, street, building_number, postal_code, city
    FROM geocoder.address
    WHERE building_id = b.external_id
    ORDER BY external_id
    LIMIT 1
  ) a ON true
  LEFT JOIN LATERAL (
    SELECT geom
    FROM geocoder.residence
    WHERE building_id = b.external_id
    ORDER BY (address_id = a.external_id) DESC, id
    LIMIT 1
  ) r ON true
  LEFT JOIN geocoder.neighborhood n ON n.id = b.neighborhood_id
  LEFT JOIN geocoder.district d ON d.id = n.district_id
  LEFT JOIN geocoder.municipality m ON m.id = d.municipality_id
  LEFT JOIN geocoder.state s ON s.id = m.state_id
  WHERE b.external_id = '__PAND__'
    AND b.active = true
    AND b.geom IS NOT NULL
  LIMIT 1
),
-- product.ts:162-194, verbatim
an as (
  SELECT
    building_id,
    neighborhood_id,
    construction_year,
    construction_year_reliability,
    foundation_type,
    foundation_type_reliability,
    restoration_costs,
    drystand,
    drystand_risk,
    drystand_risk_reliability,
    bio_infection_risk,
    bio_infection_risk_reliability,
    dewatering_depth,
    dewatering_depth_risk,
    dewatering_depth_risk_reliability,
    unclassified_risk,
    height,
    velocity,
    ground_water_level,
    ground_level,
    soil,
    surface_area,
    inquiry_type,
    damage_cause,
    enforcement_term,
    overall_quality,
    recovery_type
  FROM data.model_risk_static
  WHERE building_id = '__PAND__'
  LIMIT 1
),
-- product.ts:49-56, verbatim
hier as (
  SELECT b.neighborhood_id, d.municipality_id
  FROM geocoder.building b
  LEFT JOIN geocoder.neighborhood n ON n.id = b.neighborhood_id
  LEFT JOIN geocoder.district d ON d.id = n.district_id
  WHERE b.external_id = '__PAND__'
  LIMIT 1
),
-- product.ts:82-87, verbatim (neighborhood_id = NULL matches nothing, as in the API)
cy as (
  SELECT year_from, count
  FROM data.statistics_product_construction_years
  WHERE neighborhood_id = (SELECT neighborhood_id FROM hier)
  ORDER BY year_from
),
-- report.ts:26-64, the filter and the inner join verbatim; columns cut to what the front half needs
inq as (
  SELECT
    i.id,
    i.type,
    i.document_date,
    i.create_date,
    i.update_date
  FROM report.inquiry i
  JOIN application.attribution a ON a.id = i.attribution_id
  WHERE i.id IN (
    SELECT inquiry_id FROM report.inquiry_sample WHERE building_id = '__PAND__'
  )
  ORDER BY COALESCE(i.update_date, i.create_date) DESC
),
-- report.ts:65-69 (SELECT s.* ... WHERE s.building_id = ...); columns cut to what the front half needs,
-- plus api_order (the position in the API answer, see the header)
smp as (
  SELECT
    row_number() OVER (ORDER BY s.ctid) AS api_order,
    s.id,
    s.inquiry_id,
    s.building_id,
    s.substructure,
    s.enforcement_term,
    s.damage_characteristics,
    s.overall_quality,
    s.damage_cause,
    s.cpt,
    s.groundlevel,
    s.groundwater_level_net,
    s.monitoring_well,
    s.groundwater_level_temp
  FROM report.inquiry_sample s
  WHERE s.building_id = '__PAND__'
),
-- The Vue "combined inquiry data": one entry per (inquiry, sample of this pand), newest inquiry first.
-- Only inquiries the API returned (inner join above), only samples the API returned.
entries as (
  SELECT
    row_number() OVER (ORDER BY i.document_date DESC NULLS LAST, i.id DESC, s.api_order) AS ord,
    i.id AS inquiry_id,
    i.document_date,
    s.id AS sample_id,
    (s.enforcement_term IS NOT NULL OR s.damage_characteristics IS NOT NULL OR s.overall_quality IS NOT NULL
      OR s.damage_cause IS NOT NULL OR s.substructure IS NOT NULL) AS has_foundation_data
  FROM inq i
  JOIN smp s ON s.inquiry_id = i.id
)
SELECT json_build_object(
  'pand', '__PAND__'::text,
  'missing', (SELECT coalesce(json_agg(x), '[]'::json) FROM (
      SELECT 'building_info' AS x WHERE NOT EXISTS (SELECT 1 FROM bi)
      UNION ALL SELECT 'analysis' WHERE NOT EXISTS (SELECT 1 FROM an)
      UNION ALL SELECT 'statistics' WHERE NOT EXISTS (SELECT 1 FROM hier)) m),
  'building_info', (SELECT row_to_json(bi) FROM bi),
  'analysis', (SELECT row_to_json(an) FROM an),
  'statistics', json_build_object(
    'neighborhood_id', (SELECT neighborhood_id FROM hier),
    'municipality_id', (SELECT municipality_id FROM hier),
    'construction_year_distribution', (SELECT coalesce(json_agg(row_to_json(cy) ORDER BY cy.year_from), '[]'::json) FROM cy)
  ),
  'report', json_build_object(
    'inquiries', (SELECT coalesce(json_agg(row_to_json(inq) ORDER BY coalesce(inq.update_date, inq.create_date) DESC), '[]'::json) FROM inq),
    'inquiry_samples', (SELECT coalesce(json_agg(row_to_json(smp) ORDER BY smp.api_order), '[]'::json) FROM smp)
  ),
  'derived', json_build_object(
    -- entries in the Vue order (inquiries.ts getCombinedInquiryDataByBuildingId)
    'entries', (SELECT coalesce(json_agg(row_to_json(e) ORDER BY e.ord), '[]'::json) FROM entries e),
    -- LocationChapter.vue: inquiryData[0].sample (the newest entry, whether or not it has values)
    'location_sample_id', (SELECT sample_id FROM entries ORDER BY ord LIMIT 1),
    -- BuildingChapter.vue via utils/foundationSample.ts pickFoundationEntry: the first entry with any of the five
    -- foundation fields, else the newest entry
    'foundation_sample_id', coalesce(
      (SELECT sample_id FROM entries WHERE has_foundation_data ORDER BY ord LIMIT 1),
      (SELECT sample_id FROM entries ORDER BY ord LIMIT 1))
  )
);
