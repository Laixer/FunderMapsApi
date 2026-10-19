-- FunderMaps report, BACK HALF (Fundering, Funderingsherstel, Rapportage, Gevelscan, Pandzakking,
-- Incidenten, the risk chapter's neighbourhood pie) for one pand, as one JSON document. '__PAND__' is
-- the pand id: report-pdf/data.ts binds it as a query parameter.
--
-- READ-ONLY. Mirrors the FunderMapsApi queries (origin/main 275339e) table for table, filter for
-- filter, order for order:
--   analysis            GET /api/product/:id/analysis            src/routes/product.ts:158-211
--   statistics          GET /api/product/:id/statistics          src/routes/product.ts:44-156
--   subsidence_historic GET /api/product/:id/subsidence/historic src/routes/product.ts:30-42
--   report              GET /api/report/:id                      src/routes/report.ts:14-119
--   building_info       GET /api/geocoder/building-info/:id      src/routes/geocoder.ts:28-88 (map centre only)
--   incident_district   Martin tile source maplayer.incident_district(z,x,y) (FunderMapsWorker schema.sql),
--                       the districts of the Incidenten map at zoom 10 around the pand
-- The two /product routes also write a billing row (product_tracker, via middleware/tracker.ts);
-- this file does not: it only SELECTs.
--
-- Wire format kept as the API sends it (postgres.js through drizzle):
--   numeric and bigint (count) columns are JSON strings ("12.34", "39"), int4 and float8 are numbers,
--   date is "YYYY-MM-DD", timestamptz is PG text "2021-11-26 10:00:00.123+00" (session TimeZone GMT),
--   enum[] columns are JSON arrays of the PG labels.
-- Left out on purpose (the report prints none of it; personal or customer data):
--   report.incident.internal_note / metadata / document_file / file_resource_key,
--   inquiry & recovery attribution_reviewer_name / attribution_creator_name (user e-mails) and
--   attribution_owner_name / attribution_data_owner_name (organisation names).
-- Row order where the API has no ORDER BY (inquiry_samples, recovery_samples, subsidence_historic,
-- the statistics distributions) is whatever the scan gives, as in the API; the samples are
-- aggregated in ctid order, which is the order a plain scan returns them.
with p as (
  select '__PAND__'::text as building_id
),
h as (  -- product.ts:49-56
  select b.neighborhood_id, d.municipality_id
  from geocoder.building b
  left join geocoder.neighborhood n on n.id = b.neighborhood_id
  left join geocoder.district d on d.id = n.district_id
  where b.external_id = (select building_id from p)
  limit 1
),
info as (  -- geocoder.ts:32-82, only the columns the maps use
  select b.external_id as building_id,
         public.ST_Y(r.geom) as residence_lat, public.ST_X(r.geom) as residence_lon,
         public.ST_Y(public.ST_Centroid(b.geom)) as building_lat,
         public.ST_X(public.ST_Centroid(b.geom)) as building_lon
  from geocoder.building b
  left join lateral (select external_id from geocoder.address
                     where building_id = b.external_id order by external_id limit 1) a on true
  left join lateral (select geom from geocoder.residence
                     where building_id = b.external_id
                     order by (address_id = a.external_id) desc, id limit 1) r on true
  where b.external_id = (select building_id from p) and b.active = true and b.geom is not null
  limit 1
),
-- The Incidenten map (IncidentsChapter.vue): centre = residence point, else the pand's centroid
-- (_adapters.ts adaptGeoLocationData), else [4.897, 52.377]; zoom 10. The map is drawn at the
-- SCREEN layout size, 716.16 x 318.29 CSS px (7.46in column x aspect 495/220; canvas 717 x 319),
-- and the snapshot is then scaled into the 700 x 311 px print column (x 0.9775).
-- Mapbox GL: 512 px tiles, so 1 px = 40075016.686 / 2^19 m = 76.4370 m (EPSG:3857) at zoom 10.
view as (
  select c, ST_MakeEnvelope(ST_X(c) - 358.08 * 76.43702828517626, ST_Y(c) - 159.145 * 76.43702828517626,
                            ST_X(c) + 358.08 * 76.43702828517626, ST_Y(c) + 159.145 * 76.43702828517626, 3857) as env
  from (select ST_Transform(ST_SetSRID(ST_MakePoint(
          coalesce((select residence_lon from info), (select building_lon from info), 4.897),
          coalesce((select residence_lat from info), (select building_lat from info), 52.377)), 4326), 3857) as c) x
)
select json_build_object(
  'building_id', (select building_id from p),

  -- product.ts:162-194
  'analysis', (
    select json_build_object(
      'building_id', m.building_id, 'neighborhood_id', m.neighborhood_id,
      'construction_year', m.construction_year, 'construction_year_reliability', m.construction_year_reliability,
      'foundation_type', m.foundation_type, 'foundation_type_reliability', m.foundation_type_reliability,
      'restoration_costs', m.restoration_costs, 'drystand', m.drystand,
      'drystand_risk', m.drystand_risk, 'drystand_risk_reliability', m.drystand_risk_reliability,
      'bio_infection_risk', m.bio_infection_risk, 'bio_infection_risk_reliability', m.bio_infection_risk_reliability,
      'dewatering_depth', m.dewatering_depth, 'dewatering_depth_risk', m.dewatering_depth_risk,
      'dewatering_depth_risk_reliability', m.dewatering_depth_risk_reliability,
      'unclassified_risk', m.unclassified_risk,
      'height', m.height::text, 'velocity', m.velocity::text, 'ground_water_level', m.ground_water_level::text,
      'ground_level', m.ground_level::text, 'soil', m.soil, 'surface_area', m.surface_area::text,
      'inquiry_type', m.inquiry_type, 'damage_cause', m.damage_cause, 'enforcement_term', m.enforcement_term,
      'overall_quality', m.overall_quality, 'recovery_type', m.recovery_type)
    from data.model_risk_static m
    where m.building_id = (select building_id from p)
    limit 1),

  -- product.ts:66-155 (all of it; this half uses foundation_type_distribution,
  -- foundation_risk_distribution and total_report_count)
  'statistics', (
    select json_build_object(
      'foundation_type_distribution', coalesce((
        select json_agg(json_build_object('foundation_type', t.foundation_type,
                                          'percentage', round(t.percentage::numeric, 2)::text))
        from data.statistics_product_foundation_type t where t.neighborhood_id = h.neighborhood_id), '[]'),
      'construction_year_distribution', coalesce((
        select json_agg(json_build_object('year_from', t.year_from, 'count', t.count::text) order by t.year_from)
        from data.statistics_product_construction_years t where t.neighborhood_id = h.neighborhood_id), '[]'),
      'foundation_risk_distribution', coalesce((
        select json_agg(json_build_object('foundation_risk', t.foundation_risk,
                                          'percentage', round(t.percentage::numeric, 2)::text))
        from data.statistics_product_foundation_risk t where t.neighborhood_id = h.neighborhood_id), '[]'),
      'data_collected_percentage', (
        select round(t.percentage::numeric, 2)::text
        from data.statistics_product_data_collected t where t.neighborhood_id = h.neighborhood_id limit 1),
      'total_building_restored_count', coalesce((
        select to_json(t.count::text)
        from data.statistics_product_buildings_restored t where t.neighborhood_id = h.neighborhood_id limit 1), to_json(0)),
      'total_incident_count', coalesce((
        select json_agg(json_build_object('year', t.year, 'count', t.count::text) order by t.year)
        from data.statistics_product_incidents t where t.neighborhood_id = h.neighborhood_id), '[]'),
      'municipality_incident_count', coalesce((
        select json_agg(json_build_object('year', t.year, 'count', t.count::text) order by t.year)
        from data.statistics_product_incident_municipality t where t.municipality_id = h.municipality_id), '[]'),
      'total_report_count', coalesce((
        select json_agg(json_build_object('year', t.year, 'count', t.count::text) order by t.year)
        from data.statistics_product_inquiries t where t.neighborhood_id = h.neighborhood_id), '[]'),
      'municipality_report_count', coalesce((
        select json_agg(json_build_object('year', t.year, 'count', t.count::text) order by t.year)
        from data.statistics_product_inquiry_municipality t where t.municipality_id = h.municipality_id), '[]'))
    from h),

  -- product.ts:33-37 (no ORDER BY in the API either)
  'subsidence_historic', coalesce((
    select json_agg(json_build_object('building_id', s.building_id, 'velocity', s.velocity, 'mark_at', s.mark_at))
    from data.building_subsidence_history s
    where s.building_id = (select building_id from p)), '[]'),

  -- report.ts:18-110
  'report', json_build_object(
    'incidents', coalesce((
      select json_agg(to_jsonb(i) - 'internal_note' - 'metadata' - 'document_file' - 'file_resource_key'
                      || jsonb_build_object('create_date', i.create_date::text, 'update_date', i.update_date::text,
                                            'delete_date', i.delete_date::text)
                      order by i.create_date desc)
      from report.incident i
      where i.building_id = (select building_id from p)), '[]'),
    'inquiries', coalesce((
      select json_agg(json_build_object(
               'id', i.id, 'document_name', i.document_name, 'type', i.type, 'document_date', i.document_date,
               'document_file', i.document_file, 'note', i.note, 'inspection', i.inspection,
               'joint_measurement', i.joint_measurement, 'floor_measurement', i.floor_measurement,
               'standard_f3o', i.standard_f3o, 'audit_status', i.audit_status, 'access_policy', i.access_policy,
               'create_date', i.create_date::text, 'update_date', i.update_date::text, 'delete_date', i.delete_date::text,
               'attribution_reviewer', a.reviewer_id, 'attribution_creator', a.creator_id,
               'attribution_owner', a.owner_id, 'attribution_data_owner', i.data_owner_organization_id,
               'attribution_contractor', a.contractor_id, 'attribution_contractor_name', ct.name)
             order by coalesce(i.update_date, i.create_date) desc)
      from report.inquiry i
      join application.attribution a on a.id = i.attribution_id
      left join application.contractor ct on ct.id = a.contractor_id
      where i.id in (select inquiry_id from report.inquiry_sample where building_id = (select building_id from p))), '[]'),
    'inquiry_samples', coalesce((
      select json_agg(to_jsonb(s) || jsonb_build_object(
               'create_date', s.create_date::text, 'update_date', s.update_date::text, 'delete_date', s.delete_date::text,
               'construction_level', s.construction_level::text, 'wood_level', s.wood_level::text,
               'pile_diameter_top', s.pile_diameter_top::text, 'pile_diameter_bottom', s.pile_diameter_bottom::text,
               'pile_head_level', s.pile_head_level::text, 'pile_tip_level', s.pile_tip_level::text,
               'foundation_depth', s.foundation_depth::text, 'mason_level', s.mason_level::text,
               'concrete_charger_length', s.concrete_charger_length::text,
               'pile_distance_length', s.pile_distance_length::text,
               'wood_penetration_depth', s.wood_penetration_depth::text,
               'groundwater_level_temp', s.groundwater_level_temp::text, 'groundlevel', s.groundlevel::text,
               'groundwater_level_net', s.groundwater_level_net::text,
               'threshold_front_level', s.threshold_front_level::text, 'threshold_back_level', s.threshold_back_level::text,
               'skewed_parallel', s.skewed_parallel::text, 'skewed_perpendicular', s.skewed_perpendicular::text)
             order by s.ctid)
      from report.inquiry_sample s
      where s.building_id = (select building_id from p)), '[]'),
    'recoveries', coalesce((
      select json_agg(json_build_object(
               'id', r.id, 'document_name', r.document_name, 'type', r.type, 'document_date', r.document_date,
               'document_file', r.document_file, 'note', r.note, 'audit_status', r.audit_status,
               'access_policy', r.access_policy, 'create_date', r.create_date::text,
               'update_date', r.update_date::text, 'delete_date', r.delete_date::text,
               'attribution_reviewer', a.reviewer_id, 'attribution_creator', a.creator_id,
               'attribution_owner', a.owner_id, 'attribution_data_owner', r.data_owner_organization_id,
               'attribution_contractor', a.contractor_id, 'attribution_contractor_name', ct.name)
             order by coalesce(r.update_date, r.create_date) desc)
      from report.recovery r
      join application.attribution a on a.id = r.attribution_id
      left join application.contractor ct on ct.id = a.contractor_id
      where r.id in (select recovery_id from report.recovery_sample where building_id = (select building_id from p))), '[]'),
    'recovery_samples', coalesce((
      select json_agg(to_jsonb(s) || jsonb_build_object(
               'create_date', s.create_date::text, 'update_date', s.update_date::text, 'delete_date', s.delete_date::text)
             order by s.ctid)
      from report.recovery_sample s
      where s.building_id = (select building_id from p)), '[]')),

  -- The Incidenten map: its centre and the districts the zoom-10 view shows, as
  -- maplayer.incident_district(z, x, y) serves them below zoom 12 (geom_simple). Geometry in
  -- EPSG:3857, whole metres. px = (x - bbox[0]) / 76.437, py = (bbox[3] - y) / 76.437.
  'incident_map', (
    select json_build_object(
      'center_lon', ST_X(ST_Transform(v.c, 4326)), 'center_lat', ST_Y(ST_Transform(v.c, 4326)),
      'center_from', case when (select residence_lon from info) is not null then 'residence'
                          when (select building_lon from info) is not null then 'building_centroid'
                          else 'fallback_amsterdam' end,
      'zoom', 10, 'width_px', 716.16, 'height_px', 318.29, 'm_per_px', 76.43702828517626,
      'bbox_3857', json_build_array(round(ST_XMin(v.env)::numeric, 1), round(ST_YMin(v.env)::numeric, 1),
                                    round(ST_XMax(v.env)::numeric, 1), round(ST_YMax(v.env)::numeric, 1)),
      'districts', coalesce((
        select json_agg(json_build_object('district_id', t.district_id, 'municipality_id', t.municipality_id,
                                          'incident_count', t.incident_count,
                                          'geometry', ST_AsGeoJSON(t.geom_simple, 0)::json)
                        order by t.incident_count, t.district_id)
        from maplayer.incident_district_tiles t
        where t.geom_simple && ST_Expand(v.env, 64 * 76.43702828517626 / 8)), '[]'))
    from view v)
);
