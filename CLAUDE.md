# CLAUDE.md

## Project Overview

FunderMaps API — TypeScript port of the legacy C# `FunderMaps.WebApi`. REST API built with Bun + Hono + Drizzle ORM on top of the existing FunderMaps PostgreSQL schema (managed by `FunderMapsWorker`'s migrations + `schema.sql`).

## Stack

- **Runtime**: Bun
- **Framework**: Hono
- **ORM**: Drizzle ORM (PostgreSQL, existing multi-schema database)
- **Auth**: Better Auth (sessions, bearer plugin, admin plugin, OIDC provider, `@better-auth/api-key` plugin) + legacy SHA-256 `auth_key` fallback for unrotated keys
- **Validation**: Zod v4 + `@hono/zod-validator`
- **Storage**: `@aws-sdk/client-s3` (DigitalOcean Spaces compatible)
- **Email**: Mailgun (direct REST API via `fetch`)

## Commands

```bash
bun run src/index.ts          # Start server (port 3000)
bun run --bun tsc --noEmit    # Type check
bun test                      # Run tests
```

Database schema is **not** managed from this repo — `FunderMapsWorker` owns the migrations and `schema.sql`. The `drizzle-kit` devDep is present for Drizzle's type generation, not for `push`/`migrate`. To bootstrap a fresh DB, run `FunderMapsWorker/sql/init_db.sh`.

## Architecture

- `src/index.ts` — Hono app, middleware stack, route mounting
- `src/config.ts` — Zod-validated env vars (Bun loads `.env` automatically)
- `src/db/schema/` — One file per PG schema (`application`, `report`, `geocoder`, `data`, `maplayer`)
- `src/db/client.ts` — Drizzle + postgres.js pool
- `src/middleware/` — `auth.ts` (session + dual-stack API key), `admin.ts` (4-line literal check on `role === "administrator"`), `tracker.ts` (product-tracker billing), `error-handler.ts`
- `src/routes/` — HTTP handlers organized by domain; `management/` subdir for `/api/management/*` (admin-only)
- `src/services/` — External integrations (`geocoder`, `job`, `mail`, `storage`)
- `src/lib/` — Shared utilities and BA wiring (notably `auth.ts` — BA plugin set + Grafana OIDC client config — and `legacy-password.ts` for the PBKDF2 verify hook)
- `src/types/context.ts` — Hono `AppEnv` type

## Database Schemas

PostgreSQL with multiple schemas: `application.*`, `geocoder.*`, `report.*`, `data.*`, `maplayer.*`. PostGIS is loaded; geometry columns are typed as `text()` in Drizzle (no first-class geometry type) — wrap reads with `ST_AsText`/`ST_AsGeoJSON` when you need a usable shape.

## Auth

Better Auth handles email/password login, sessions, password reset, and an OIDC provider surface (Grafana is currently the only registered trusted client; hardcoded in `src/lib/auth.ts` pending DB-driven `trustedClients`). The bearer plugin lets clients send session tokens as `Authorization: Bearer …`.

**API keys are dual-stack** (`src/middleware/auth.ts`):
1. Try `auth.api.verifyApiKey({ key })` against `application.apikey` (BA-issued keys, prefix `fmsk.`).
2. On `INVALID_API_KEY` miss, fall back to a SHA-256 hex lookup against the legacy `application.auth_key` table.

`KEY_DISABLED`/`KEY_EXPIRED`/`RATE_LIMIT_EXCEEDED` are hard rejects with no fallback. The legacy path will be removed in Phase D after the C# Webservice retires end of December 2026 and `auth_key` drains.

Admin routes require `c.get("user").role === "administrator"`. Two writers to that column today: BA's `setRole` (via the admin plugin's `/api/auth/admin/*` surface) and this repo's `routes/management/user.ts`. Same literal both sides — fine, but a co-existence point to keep in mind.

Better Auth routes mount at `/api/auth/*`. The FunderMaps-specific admin surface stays at `/api/management/*` and is **not** rewritten onto BA's `/api/auth/admin/*` — `/api/management/*` covers ~50 endpoints (geolocks, mapsets, jobs, layers, api-key admin) that BA can't replace anyway.

## Route Surface (mounted in `src/index.ts`)

Public (no auth):
- `GET /health` — liveness
- `/api/diag` — request echo / forwarded-IP probe
- `/api/app` — frontend app config
- `/api/geocoder` — building/address/residence/neighborhood/district/municipality/state lookup
- `/api/mapset` — layer set metadata
- `/api/data/contractor` — contractor reference data

Auth-protected (session or `fmsk.` API key):
- `/api/user` — profile, metadata, account self-service
- `/api/organization` — session org + members + by-id (membership-checked)
- `/api/reviewer` — users with `verifier`/`superuser` role in the session org
- `/api/product/:building_id` — analysis/statistics/subsidence (billable, runs through `trackerMiddleware`)
- `/api/report/:building_id` — building report bundle
- `/api/inquiry`, `/api/inquiry/:inquiry_id/sample` — full CRUD + audit workflow + status emails (Mailgun templates `report-reviewer`/`report-approved`/`report-declined`)
- `/api/recovery`, `/api/recovery/:recovery_id/sample` — same shape as inquiry
- `/api/incident` — read-only listing by building (no submission surface — incidents reach `report.incident` via other channels)
- `/api/pdf` — async PDF generation through the worker

Admin-only (`/api/management/*` — gated by `adminMiddleware`):
- `app`, `incident` (delete), `jobs`, `layer`, `mapset`, `organization`, `session`, `user`

## What's NOT Yet Implemented

Pending items here are **load-bearing, not aspirational**. Speculative parity gaps against the long-retired C# WebApi (e.g. `IncidentController`, `PDOKLocationService` exposure, `VersionController`) have been removed — re-add only with a concrete consumer.

**Auth migration (Better Auth, see `~/.claude/projects/-home-eve/memory/project_better_auth_migration.md`):**
- **OIDC `trustedClients` → DB-driven** (Phase 1, step 3). Grafana is hardcoded in `src/lib/auth.ts:196` because `oidc-provider`'s DB fallback doesn't expose `skipConsent`. Real prerequisite for the planned auth SPA (`auth.fundermaps.com`), where every first-party frontend becomes an OIDC client. Likely also paired with the migration from `better-auth/plugins/oidc-provider` (deprecated, removed in BA 1.7) to the separate `@better-auth/oauth-provider` package.
- **Legacy PBKDF2 verify hook removal** (Phase 1, step 1, finish). Auto-upgrade is live (`src/lib/auth.ts` + `src/lib/legacy-password.ts`). When `SELECT count(*) FROM application.account WHERE provider_id='credential' AND password NOT LIKE '%:%'` reaches 0, the legacy verify hook + helper become dead code and should be deleted.
- **apiKey Phase C drain** (operational, customer-paced). New keys go through BA; legacy `application.auth_key` rows are only validated, never rotated server-side. Monitor with the query pinned in the migration plan memory. Phase D (legacy fallback + table drop) lands post-Dec-2026 when the C# Webservice retires.
- **Better Auth `organization` plugin** (Phase 2). Biggest blast radius — BA's org/member tables don't match `application.organization` + `organization_user`; preferred shape is per-plugin schema override so C# joins keep compiling until retirement.

**DB hygiene** (see `~/.claude/projects/-home-eve/memory/project_todos.md`):
- **GFM cleanup tail** + **`geocoder.building_active` view removal**. The view has 15+ dependents through a chain of maplayer views, statistics matviews, and Worker-managed objects. Single migration of 200+ lines of SQL; explicitly "not a small win, defer."

## Reference Codebases

- **C# WebApi** at `~/Projects/FunderMaps/src/FunderMaps.WebApi` — the parity reference for ported features. Not running anywhere in prod; retired in favor of this repo.
- **C# Webservice** at `~/Projects/FunderMaps/src/FunderMaps.Webservice` — still serves `ws.fundermaps.com` until **end of December 2026**. Coexistence shape matters for auth-key and org-context changes; see the BA migration memory.
