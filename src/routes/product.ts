import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { NotFoundError } from "../lib/errors.ts";
import { resolveToBuildingId } from "../services/geocoder.ts";
import type { AppEnv } from "../types/context.ts";

const product = new Hono<AppEnv>();

product.get("/subsidence", async (c) => {
  const buildingId = c.req.param("building_id")!;

  const result = await db.execute(sql`
    SELECT building_id, velocity
    FROM data.building_subsidence
    WHERE building_id = ${buildingId}
    LIMIT 1
  `);

  if (result.length === 0)
    throw new NotFoundError("Subsidence data not found");

  return c.json(result[0]);
});

product.get("/subsidence/historic", async (c) => {
  const buildingId = c.req.param("building_id")!;

  const result = await db.execute(sql`
    SELECT building_id, velocity, mark_at
    FROM data.building_subsidence_history
    WHERE building_id = ${buildingId}
  `);

  if (result.length === 0)
    throw new NotFoundError("Historic subsidence data not found");

  return c.json(result);
});

product.get("/statistics", async (c) => {
  const input = c.req.param("building_id")!;
  const buildingId = await resolveToBuildingId(input);

  // Resolve neighborhood + municipality (statistics matviews are keyed on those, not building).
  const hierarchy = await db.execute(sql`
    SELECT b.neighborhood_id, d.municipality_id
    FROM geocoder.building b
    LEFT JOIN geocoder.neighborhood n ON n.id = b.neighborhood_id
    LEFT JOIN geocoder.district d ON d.id = n.district_id
    WHERE b.external_id = ${buildingId}
    LIMIT 1
  `);

  if (hierarchy.length === 0)
    throw new NotFoundError("Building geographic hierarchy not found");

  const { neighborhood_id, municipality_id } = hierarchy[0] as {
    neighborhood_id: string | null;
    municipality_id: string | null;
  };

  const [
    foundation_type_distribution,
    construction_year_distribution,
    foundation_risk_distribution,
    data_collected,
    buildings_restored,
    incidents,
    incident_municipality,
    inquiries,
    inquiry_municipality,
  ] = await Promise.all([
    db.execute(sql`
      SELECT foundation_type, round(percentage::numeric, 2) AS percentage
      FROM data.statistics_product_foundation_type
      WHERE neighborhood_id = ${neighborhood_id}
    `),
    db.execute(sql`
      SELECT year_from, count
      FROM data.statistics_product_construction_years
      WHERE neighborhood_id = ${neighborhood_id}
      ORDER BY year_from
    `),
    db.execute(sql`
      SELECT foundation_risk, round(percentage::numeric, 2) AS percentage
      FROM data.statistics_product_foundation_risk
      WHERE neighborhood_id = ${neighborhood_id}
    `),
    db.execute(sql`
      SELECT round(percentage::numeric, 2) AS percentage
      FROM data.statistics_product_data_collected
      WHERE neighborhood_id = ${neighborhood_id}
      LIMIT 1
    `),
    db.execute(sql`
      SELECT count
      FROM data.statistics_product_buildings_restored
      WHERE neighborhood_id = ${neighborhood_id}
      LIMIT 1
    `),
    db.execute(sql`
      SELECT year, count
      FROM data.statistics_product_incidents
      WHERE neighborhood_id = ${neighborhood_id}
      ORDER BY year
    `),
    db.execute(sql`
      SELECT year, count
      FROM data.statistics_product_incident_municipality
      WHERE municipality_id = ${municipality_id}
      ORDER BY year
    `),
    db.execute(sql`
      SELECT year, count
      FROM data.statistics_product_inquiries
      WHERE neighborhood_id = ${neighborhood_id}
      ORDER BY year
    `),
    db.execute(sql`
      SELECT year, count
      FROM data.statistics_product_inquiry_municipality
      WHERE municipality_id = ${municipality_id}
      ORDER BY year
    `),
  ]);

  const orgId = c.get("user").organizations[0]?.id;
  if (orgId) {
    c.set("tracker", {
      name: "statistics",
      buildingId,
      identifier: orgId,
    });
  }

  return c.json({
    foundation_type_distribution,
    construction_year_distribution,
    foundation_risk_distribution,
    data_collected_percentage:
      (data_collected[0] as { percentage: number } | undefined)?.percentage ??
      null,
    total_building_restored_count:
      (buildings_restored[0] as { count: number } | undefined)?.count ?? 0,
    total_incident_count: incidents,
    municipality_incident_count: incident_municipality,
    total_report_count: inquiries,
    municipality_report_count: inquiry_municipality,
  });
});

product.get("/analysis", async (c) => {
  const input = c.req.param("building_id")!;
  const buildingId = await resolveToBuildingId(input);

  const result = await db.execute(sql`
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
    WHERE building_id = ${buildingId}
    LIMIT 1
  `);

  if (result.length === 0)
    throw new NotFoundError("Analysis data not found");

  const orgId = c.get("user").organizations[0]?.id;
  if (orgId) {
    c.set("tracker", {
      name: "analysis",
      buildingId,
      identifier: orgId,
    });
  }

  return c.json(result[0]);
});

export default product;
