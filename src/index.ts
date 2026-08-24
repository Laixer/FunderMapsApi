import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { cors } from "hono/cors";
import { env } from "./config.ts";
import { auth } from "./lib/auth.ts";
import { errorHandler } from "./middleware/error-handler.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { adminMiddleware } from "./middleware/admin.ts";
import { trackerMiddleware } from "./middleware/tracker.ts";
import type { AppEnv } from "./types/context.ts";

// Routes
import contractorRoutes from "./routes/contractor.ts";
import geocoderRoutes from "./routes/geocoder.ts";
import userRoutes from "./routes/user.ts";
import organizationRoutes from "./routes/organization.ts";
import reviewerRoutes from "./routes/reviewer.ts";
import mapsetRoutes from "./routes/mapset.ts";
import productRoutes from "./routes/product.ts";
import reportRoutes from "./routes/report.ts";
import inquiryRoutes from "./routes/inquiry.ts";
import inquirySampleRoutes from "./routes/inquiry-sample.ts";
import recoveryRoutes from "./routes/recovery.ts";
import recoverySampleRoutes from "./routes/recovery-sample.ts";
import incidentRoutes from "./routes/incident.ts";
import intakeRoutes from "./routes/intake.ts";
import dataopsRoutes from "./routes/dataops.ts";
import pdfRoutes from "./routes/pdf.ts";
import managementRoutes from "./routes/management/index.ts";

const app = new Hono<AppEnv>();

// Global middleware
app.use("*", logger());
app.use("*", secureHeaders());

// CORS. First-party origins (the auth SPA + admin/app frontends listed in
// TRUSTED_ORIGINS) get *credentialed* CORS so the Better Auth session cookie
// can be set on sign-in and sent on the subsequent /oauth2/authorize navigation
// (a navigation can't carry a bearer header). Everyone else keeps permissive,
// cookie-less CORS (bearer / API-key callers + public endpoints) — additive,
// so it changes nothing for existing consumers.
const credentialedCors = cors({
  origin: (origin) => (origin && env.TRUSTED_ORIGINS.includes(origin) ? origin : null),
  credentials: true,
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});
const publicCors = cors();
app.use("*", (c, next) => {
  const origin = c.req.header("Origin");
  return origin && env.TRUSTED_ORIGINS.includes(origin)
    ? credentialedCors(c, next)
    : publicCors(c, next);
});

// Error handler
app.onError(errorHandler);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Better Auth routes (sign-up, sign-in, sign-out, session, etc.)
app.on(["POST", "GET"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

// Public routes
app.route("/api/geocoder", geocoderRoutes);

// Public routes (continued)
app.route("/api/data/contractor", contractorRoutes);

// The public intake lane. Deliberately not folded into /api/incident, which is
// behind authMiddleware: an anonymous write path carved out inside an
// authenticated prefix is a mistake waiting to happen. It carries its own
// shared-secret check instead (see routes/intake.ts).
app.route("/api/intake", intakeRoutes);

// Authenticated routes
app.use("/api/user", authMiddleware);
app.use("/api/user/*", authMiddleware);
app.route("/api/user", userRoutes);

app.use("/api/organization", authMiddleware);
app.use("/api/organization/*", authMiddleware);
app.route("/api/organization", organizationRoutes);

app.use("/api/reviewer", authMiddleware);
app.use("/api/reviewer/*", authMiddleware);
app.route("/api/reviewer", reviewerRoutes);

// /api/mapset auth is per-route inside mapsetRoutes — list requires auth,
// /:mapset_id slug lookup is public.
app.route("/api/mapset", mapsetRoutes);

app.use("/api/product/*", authMiddleware, trackerMiddleware);
app.route("/api/product/:building_id", productRoutes);

app.use("/api/report/*", authMiddleware);
app.route("/api/report/:building_id", reportRoutes);

app.use("/api/inquiry/*", authMiddleware);
app.route("/api/inquiry/:inquiry_id/sample", inquirySampleRoutes);
app.route("/api/inquiry", inquiryRoutes);

app.use("/api/recovery/*", authMiddleware);
app.route("/api/recovery/:recovery_id/sample", recoverySampleRoutes);
app.route("/api/recovery", recoveryRoutes);

app.use("/api/incident/*", authMiddleware);
app.route("/api/incident", incidentRoutes);
// The review lane is staff-only: it exposes documents from every organisation
// that has submitted one, and the verdicts recorded here become training data.
app.use("/api/dataops", authMiddleware);
app.use("/api/dataops/*", authMiddleware);
app.route("/api/dataops", dataopsRoutes);

app.use("/api/pdf/*", authMiddleware);
app.route("/api/pdf", pdfRoutes);

// Management routes (admin only)
app.use("/api/management/*", authMiddleware, adminMiddleware);
app.route("/api/management", managementRoutes);

// 404 fallback
app.notFound((c) => c.json({ message: "Not found" }, 404));

export default {
  port: env.PORT,
  // Default 10s is too tight for /api/pdf/:id, which holds the request while
  // Gotenberg renders the report SPA in headless Chromium (chart-heavy reports
  // can take 30–60s+). Match the 5-minute AbortSignal in routes/pdf.ts.
  idleTimeout: 255,
  fetch: app.fetch,
};
