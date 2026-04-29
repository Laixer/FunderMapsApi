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
import diagRoutes from "./routes/diag.ts";
import appRoutes from "./routes/app.ts";
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
import incidentRoutes from "./routes/incident.ts";
import pdfRoutes from "./routes/pdf.ts";
import managementRoutes from "./routes/management/index.ts";

const app = new Hono<AppEnv>();

// Global middleware
app.use("*", logger());
app.use("*", secureHeaders());
app.use("*", cors());

// Error handler
app.onError(errorHandler);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Better Auth routes (sign-up, sign-in, sign-out, session, etc.)
app.on(["POST", "GET"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

// Public routes
app.route("/api/diag", diagRoutes);
app.route("/api/app", appRoutes);
app.route("/api/geocoder", geocoderRoutes);

// Public routes (continued)
app.route("/api/data/contractor", contractorRoutes);

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
app.route("/api/recovery", recoveryRoutes);

app.use("/api/incident/*", authMiddleware);
app.route("/api/incident", incidentRoutes);

app.use("/api/pdf/*", authMiddleware);
app.route("/api/pdf", pdfRoutes);

// Management routes (admin only)
app.use("/api/management/*", authMiddleware, adminMiddleware);
app.route("/api/management", managementRoutes);

// 404 fallback
app.notFound((c) => c.json({ message: "Not found" }, 404));

export default {
  port: env.PORT,
  fetch: app.fetch,
};
