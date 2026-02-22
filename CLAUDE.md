# CLAUDE.md

## Project Overview

FunderMaps API — TypeScript rewrite of the Go/C# backend. REST API built with Bun + Hono + Drizzle ORM + PostgreSQL.

## Stack

- **Runtime**: Bun
- **Framework**: Hono
- **ORM**: Drizzle ORM (PostgreSQL, existing multi-schema database)
- **Auth**: ZITADEL Cloud (JWT via JWKS) + API key auth (`fmsk.` prefix)
- **Validation**: Zod v4 + @hono/zod-validator
- **Storage**: @aws-sdk/client-s3 (DigitalOcean Spaces compatible)
- **Email**: Mailgun (direct REST API via fetch)

## Commands

```bash
bun run src/index.ts          # Start server (port 3000)
bun run --bun tsc --noEmit    # Type check
bun test                      # Run tests
```

## Architecture

- `src/index.ts` — Hono app, middleware stack, route mounting
- `src/config.ts` — Zod-validated env vars (Bun loads .env automatically)
- `src/db/schema/` — One file per PG schema (application, report, geocoder, data, maplayer)
- `src/db/client.ts` — Drizzle + postgres.js pool
- `src/middleware/` — auth (JWT+API key), admin, tracker, error-handler
- `src/routes/` — HTTP handlers organized by domain, `management/` sub-package for admin
- `src/services/` — Business logic (geocoder, incident, storage, mail, job)
- `src/lib/` — Shared utilities (errors, geocoder-id, pagination)
- `src/types/context.ts` — Hono AppEnv type

## Database Schemas

PostgreSQL with multiple schemas: `application.*`, `geocoder.*`, `report.*`, `data.*`, `maplayer.*`

Use `bunx drizzle-kit push` to sync schema to a fresh database.

## Auth

ZITADEL handles login/OAuth2/password flows. The API validates JWTs via ZITADEL JWKS endpoint. API key auth (`X-API-Key` header) falls back to `application.auth_key` table lookup. Admin routes require `role === "administrator"`.

## What's Implemented (~70% of full C# parity)

All Go backend routes are ported:
- Public: health, diag, contractors, geocoder (building+address), app, mapset
- Auth-protected: user profile/metadata, product (analysis/statistics/subsidence), report, inquiry/recovery (create), PDF
- Management (admin): users, apps, orgs (+ geolock), mapsets, incidents, jobs
- Services: geocoder lookup, incident creation + email, S3 upload, mailgun, worker jobs

## What's NOT Yet Implemented (C# features)

High priority:
- Inquiry/Recovery audit workflow (state machine: Todo→Pending→Review→Done/Rejected + emails at each transition)
- Inquiry/Recovery full CRUD (GET by ID, list, update, delete) — currently create-only
- Document download (pre-signed S3 URLs with time-limited access)

Medium priority:
- Organization controller for regular users (GET session org, list org users)
- Reviewer list endpoint (users with Verifier/Superuser role)
- Extended geocoder endpoints (neighborhood, district, municipality, state, residence)
- PDOK Dutch address lookup/autocomplete integration
- Per-org role authorization hierarchy (Reader/Writer/Verifier/Superuser)
- Incident full CRUD + status reset (currently create-only)

Low priority:
- Version endpoint with git commit
- Mapbox tileset upload

## Reference Codebases

- Go backend: `~/Projects/FunderMapsTest` (fully ported)
- C# backend: `~/Projects/FunderMaps` (partially ported — see gaps above)

## Original Plan

Full rewrite plan at `~/.claude/plans/polymorphic-sauteeing-mccarthy.md`
