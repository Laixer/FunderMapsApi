import {
  pgSchema,
  text,
  integer,
  bigint,
  numeric,
  doublePrecision,
  real,
  uuid,
  date,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const dataSchema = pgSchema("data");

export const building_precomputed = dataSchema.table("building_precomputed", {
  building_id: text().notNull(),
  neighborhood_id: text(),
  surface_area: numeric({ precision: 10, scale: 2 }),
  address_count: integer().notNull().default(0),
  construction_year_bag: integer(),
  height: doublePrecision(),
  ground_level: numeric({ precision: 5, scale: 2 }),
});

// Source tables used by the model pipeline. Worker writes to these
// (via raw SQL); API may read them.
export const building_cluster = dataSchema.table("building_cluster", {
  building_id: text().notNull(),
  cluster_id: uuid().notNull(),
});

// height is a STORED GENERATED column (roof - ground). Drizzle expresses
// generated stored columns via .generatedAlwaysAs(...).
export const building_elevation = dataSchema.table("building_elevation", {
  building_id: text().notNull(),
  ground: real(),
  roof: real(),
  height: real().generatedAlwaysAs(sql`(roof - ground)`),
});

export const building_geographic_region = dataSchema.table(
  "building_geographic_region",
  {
    building_id: text().notNull(),
    geographic_region_id: integer().notNull(),
    code: text().notNull(),
  },
);

export const building_groundwater_level = dataSchema.table(
  "building_groundwater_level",
  {
    building_id: text().notNull(),
    level: doublePrecision().notNull(),
  },
);

export const building_ownership = dataSchema.table("building_ownership", {
  building_id: text().notNull(),
  owner: text().notNull(),
});

export const building_pleistocene = dataSchema.table("building_pleistocene", {
  building_id: text().notNull(),
  depth: doublePrecision(),
});

export const building_subsidence = dataSchema.table("building_subsidence", {
  building_id: text().notNull(),
  velocity: doublePrecision().notNull(),
});

export const building_subsidence_history = dataSchema.table(
  "building_subsidence_history",
  {
    building_id: text().notNull(),
    velocity: doublePrecision().notNull(),
    mark_at: date().notNull(),
  },
);

// Recovery sample for clustered buildings — type is the report.recovery_type
// enum, declared as text() per the codebase convention.
export const cluster_recovery_sample = dataSchema.table(
  "cluster_recovery_sample",
  {
    cluster_id: uuid().notNull(),
    type: text(),
  },
);

export const supercluster = dataSchema.table("supercluster", {
  cluster_id: uuid().notNull(),
  supercluster_id: uuid().notNull(),
});

// Matviews used by the model pipeline. Column shapes mirror the
// report.* domains and enums (declared as text per the codebase
// convention; numeric(5,2) for the report.height domain).
const reportHeight = () =>
  numeric({ precision: 5, scale: 2, mode: "number" });

export const building_sample = dataSchema.table("building_sample", {
  building_id: text(),
  foundation_type: text(),
  enforcement_term: text(),
  damage_cause: text(),
  overall_quality: text(),
  recovery_advised: boolean(),
  built_year: integer(),
  groundwater_level: reportHeight(),
  wood_level: reportHeight(),
  foundation_depth: reportHeight(),
  inquiry_type: text(),
  document_date: date(),
  id: integer(),
});

export const cluster_sample = dataSchema.table("cluster_sample", {
  cluster_id: uuid(),
  foundation_type: text(),
  enforcement_term: text(),
  damage_cause: text(),
  overall_quality: text(),
  recovery_advised: boolean(),
  built_year: integer(),
  groundwater_level: reportHeight(),
  wood_level: reportHeight(),
  foundation_depth: reportHeight(),
  inquiry_type: text(),
  document_date: date(),
  id: integer(),
});

export const supercluster_sample = dataSchema.table("supercluster_sample", {
  supercluster_id: uuid(),
  foundation_type: text(),
  enforcement_term: text(),
  damage_cause: text(),
  overall_quality: text(),
  recovery_advised: boolean(),
  built_year: integer(),
  groundwater_level: reportHeight(),
  wood_level: reportHeight(),
  foundation_depth: reportHeight(),
  inquiry_type: text(),
  document_date: date(),
  id: integer(),
});

export const statistics_postal_code_data_collected = dataSchema.table(
  "statistics_postal_code_data_collected",
  {
    postal_code: text(),
    percentage: doublePrecision(),
  },
);

export const statistics_postal_code_foundation_risk = dataSchema.table(
  "statistics_postal_code_foundation_risk",
  {
    postal_code: text(),
    foundation_risk: text(),
    percentage: numeric(),
  },
);

export const statistics_postal_code_foundation_type = dataSchema.table(
  "statistics_postal_code_foundation_type",
  {
    postal_code: text(),
    foundation_type: text(),
    percentage: numeric(),
  },
);

// Other views in the data schema not modeled here:
//   building_geo_hierarchy (VIEW) — joins model_risk_static with geocoder
//   building_height (VIEW) — derived from building_elevation
//   model_risk_dynamic_all (VIEW) — source for model_risk_static matview
// None are queried via Drizzle; add a table declaration here if needed.

// Materialized view. Columns mirror data.model_risk_static in schema.sql.
// NOTE: the *_risk_reliability columns are the actual PG names; do not
// shorten to *_reliability — the C# wire format aliased them but PG didn't.
//
// numeric vs double precision: the matview projects round((... )::numeric, 2)
// for velocity/ground_water_level and bare numeric(p,s) for height/ground_level/
// surface_area; postgres.js returns these as STRINGS by default. drystand /
// dewatering_depth / enforcement_term are double precision (returned as
// numbers). Don't downgrade these to real() — that loses the distinction.
export const model_risk_static = dataSchema.table("model_risk_static", {
  building_id: text(),
  address_count: integer(),
  neighborhood_id: text(),
  construction_year: integer(),
  construction_year_reliability: text(),
  foundation_type: text(),
  foundation_type_reliability: text(),
  restoration_costs: integer(),
  drystand: doublePrecision(),
  drystand_risk: text(),
  drystand_risk_reliability: text(),
  bio_infection_risk: text(),
  bio_infection_risk_reliability: text(),
  dewatering_depth: doublePrecision(),
  dewatering_depth_risk: text(),
  dewatering_depth_risk_reliability: text(),
  unclassified_risk: text(),
  height: numeric({ precision: 10, scale: 2 }),
  velocity: numeric(),
  ground_water_level: numeric(),
  ground_level: numeric({ precision: 5, scale: 2 }),
  soil: text(),
  surface_area: numeric({ precision: 10, scale: 2 }),
  owner: text(),
  inquiry_id: integer(),
  inquiry_type: text(),
  damage_cause: text(),
  enforcement_term: doublePrecision(),
  overall_quality: text(),
  recovery_type: text(),
});

export const statistics_product_buildings_restored = dataSchema.table(
  "statistics_product_buildings_restored",
  {
    neighborhood_id: text(),
    count: bigint({ mode: "number" }),
  },
);

export const statistics_product_construction_years = dataSchema.table(
  "statistics_product_construction_years",
  {
    neighborhood_id: text(),
    year_from: integer(),
    count: bigint({ mode: "number" }),
  },
);

export const statistics_product_data_collected = dataSchema.table(
  "statistics_product_data_collected",
  {
    neighborhood_id: text(),
    percentage: doublePrecision(),
  },
);

export const statistics_product_foundation_risk = dataSchema.table(
  "statistics_product_foundation_risk",
  {
    neighborhood_id: text(),
    foundation_risk: text(),
    percentage: numeric(),
  },
);

export const statistics_product_foundation_type = dataSchema.table(
  "statistics_product_foundation_type",
  {
    neighborhood_id: text(),
    foundation_type: text(),
    percentage: numeric(),
  },
);

export const statistics_product_incidents = dataSchema.table(
  "statistics_product_incidents",
  {
    neighborhood_id: text(),
    year: integer(),
    count: bigint({ mode: "number" }),
  },
);

export const statistics_product_incident_municipality = dataSchema.table(
  "statistics_product_incident_municipality",
  {
    municipality_id: text(),
    year: integer(),
    count: bigint({ mode: "number" }),
  },
);

export const statistics_product_inquiries = dataSchema.table(
  "statistics_product_inquiries",
  {
    neighborhood_id: text(),
    year: integer(),
    count: bigint({ mode: "number" }),
  },
);

export const statistics_product_inquiry_municipality = dataSchema.table(
  "statistics_product_inquiry_municipality",
  {
    municipality_id: text(),
    year: integer(),
    count: bigint({ mode: "number" }),
  },
);
