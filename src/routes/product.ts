import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { modelRiskStatic } from "../db/schema/data.ts";
import { NotFoundError } from "../lib/errors.ts";
import type { AppEnv } from "../types/context.ts";

const product = new Hono<AppEnv>();

product.get("/analysis", async (c) => {
  const buildingId = c.req.param("building_id")!;

  const rows = await db
    .select()
    .from(modelRiskStatic)
    .where(eq(modelRiskStatic.buildingId, buildingId))
    .limit(1);

  if (rows.length === 0) throw new NotFoundError("Analysis not found");

  c.set("tracker", {
    name: "analysis3",
    buildingId,
    identifier: c.get("user").id,
  });

  return c.json(rows[0]);
});

product.get("/statistics", async (c) => {
  const buildingId = c.req.param("building_id")!;

  // Get neighborhood from analysis
  const analysis = await db
    .select({ neighborhoodId: modelRiskStatic.neighborhoodId })
    .from(modelRiskStatic)
    .where(eq(modelRiskStatic.buildingId, buildingId))
    .limit(1);

  if (analysis.length === 0) throw new NotFoundError("Building not found");
  const neighborhoodId = analysis[0]!.neighborhoodId;

  // Get municipality from neighborhood (first 6 chars of neighborhood BU code → GM prefix)
  const municipalityId = neighborhoodId
    ? `GM${neighborhoodId.substring(2, 6)}`
    : null;

  const [
    foundationTypes,
    constructionYears,
    dataCollected,
    foundationRisk,
    buildingsRestored,
    incidentCounts,
    municipalityIncidents,
    reportCounts,
    municipalityReports,
  ] = await Promise.all([
    db.execute(sql`
      SELECT foundation_type, round(percentage::numeric, 2) as percentage
      FROM data.statistics_product_foundation_type
      WHERE neighborhood_id = ${neighborhoodId}
    `),
    db.execute(sql`
      SELECT year_from, count
      FROM data.statistics_product_construction_years
      WHERE neighborhood_id = ${neighborhoodId}
    `),
    db.execute(sql`
      SELECT percentage
      FROM data.statistics_product_data_collected
      WHERE neighborhood_id = ${neighborhoodId}
    `),
    db.execute(sql`
      SELECT foundation_risk, round(percentage::numeric, 2) as percentage
      FROM data.statistics_product_foundation_risk
      WHERE neighborhood_id = ${neighborhoodId}
    `),
    db.execute(sql`
      SELECT count
      FROM data.statistics_product_buildings_restored
      WHERE neighborhood_id = ${neighborhoodId}
    `),
    db.execute(sql`
      SELECT year, count
      FROM data.statistics_product_incidents
      WHERE neighborhood_id = ${neighborhoodId}
    `),
    municipalityId
      ? db.execute(sql`
          SELECT year, count
          FROM data.statistics_product_incident_municipality
          WHERE municipality_id = ${municipalityId}
        `)
      : Promise.resolve([]),
    db.execute(sql`
      SELECT year, count
      FROM data.statistics_product_inquiries
      WHERE neighborhood_id = ${neighborhoodId}
    `),
    municipalityId
      ? db.execute(sql`
          SELECT year, count
          FROM data.statistics_product_inquiry_municipality
          WHERE municipality_id = ${municipalityId}
        `)
      : Promise.resolve([]),
  ]);

  return c.json({
    foundation_type_distribution: foundationTypes,
    construction_year_distribution: constructionYears,
    data_collected_percentage:
      (dataCollected[0] as { percentage?: number } | undefined)?.percentage ?? 0,
    foundation_risk_distribution: foundationRisk,
    building_restored_count:
      (buildingsRestored[0] as { count?: number } | undefined)?.count ?? 0,
    incident_counts: incidentCounts,
    neighborhood_report_counts: reportCounts,
    municipality_incident_counts: municipalityIncidents,
    municipality_report_counts: municipalityReports,
  });
});

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

export default product;
