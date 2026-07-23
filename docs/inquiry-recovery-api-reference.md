# Inquiry & Recovery API reference

Complete endpoint reference for the `/api/inquiry`, `/api/recovery`, and their
`/sample` sub-resources, for external clients (survey firms submitting reports
into a customer tenant).

This is the **reference**; for the provisioning + first-submission walkthrough
see [`external-provider-onboarding.md`](external-provider-onboarding.md).

> ⚠️ **Experimental.** This external-client surface is still experimental and
> subject to change without notice — endpoints, request/response shapes, field
> names, and enum values may change between releases, and there is no
> versioning or deprecation guarantee yet. Do not build production integrations
> against it without coordinating with the FunderMaps team first.

- **Base URL:** `https://api.fundermaps.com` (production).
- **Content type:** `application/json` for all bodies except document upload
  (`multipart/form-data`).
- **Versioning:** unversioned and experimental (see the notice above); the
  shape is a port of the legacy C# WebApi but is not yet contractually stable
  for external clients.

---

## Authentication

Every `/api/inquiry/*` and `/api/recovery/*` request requires authentication.
External clients authenticate with an API key:

```
Authorization: Bearer fmsk.<key>
```

- **Bearer is the only accepted delivery.** `X-API-Key` and
  `Authorization: AuthKey …` are **not** accepted. The same `fmsk.` key and
  header work against both `api.fundermaps.com` and `ws.fundermaps.com`.
- A Bearer token **without** the `fmsk.` prefix is treated as a Better Auth
  session token instead (used by the first-party web apps).
- Missing/invalid credentials → **401**.

The key is issued once by the customer admin and maps to a single user in one
organization. See the onboarding doc for issuing/revoking keys.

---

## Organization scope & roles

Every operation is scoped to the **caller's organization** (the first org the
authenticated user belongs to). Reads are filtered to rows owned by that org;
an id that exists but belongs to another org returns **404** (not 403), so org
boundaries are not even enumerable.

Authorization is by the caller's **org role** (`reader` / `writer` /
`verifier` / `superuser`):

| Operation | Minimum role |
|---|---|
| Read (list / get / stats / download) | any member |
| Upload document, create/update report, add/update/delete sample, request review, reset | `writer` |
| Approve / reject | `verifier` |
| Delete report (cascades to samples + attribution) | `superuser` |

`verifier` and `superuser` also satisfy `writer`; `superuser` satisfies all.
A role too low for the operation → **403**.

**Creator ≠ reviewer:** when creating or updating a report, the `reviewer` in
the attribution block must not be the calling user → **403** otherwise.

---

## Conventions

**Enumerated fields are integers on the wire.** Every `type`, `*Type`,
`*Quality`, `*Cause`, `status`, etc. is sent and returned as the integer value
listed in the [Enum reference](#enum-reference) — not the string. Sending an
integer outside the defined set returns **500** (treated as a server-side
mapping error), so validate against the tables below before sending.

**Response envelopes (reports).** `GET`/`POST` of an inquiry or recovery return
a nested shape:

```jsonc
{
  "id": 120000,
  "documentName": "…",
  "documentDate": "2026-05-13",
  "documentFile": "<uuid>.pdf",
  "type": 1,
  "note": null,
  "attribution": {
    "reviewer": "<uuid>", "reviewerName": "rev@org.example",
    "creator":  "<uuid>", "creatorName":  "you@provider.example",
    "owner":    "<uuid>", "ownerName":    "Customer BV",
    "contractor": 42,      "contractorName": "Acme Surveys BV"
  },
  "state":  { "auditStatus": 0 },     // 0 = todo — see state machine
  "access": { "accessPolicy": 1 },    // 1 = private (always, for submissions)
  "record": { "createDate": "…Z", "updateDate": null, "deleteDate": null }
}
```

Inquiry adds `inspection`, `jointMeasurement`, `floorMeasurement`,
`standardF3o` booleans. Samples are returned **flat** (no envelopes).

**Pagination.** List endpoints accept `?limit=` (default 100) and `?offset=`
(default 0). Reports are ordered by `updateDate` (then `createDate`)
descending; samples by ascending `id`.

**Filtering & sorting (inquiry list only).** `GET /api/inquiry` additionally
accepts:

- `?status=` — one or more `auditStatus` wire integers, comma-separated
  (e.g. `status=4` or `status=0,1,5`).
- `?creator=` / `?reviewer=` — a user id; filters on the report's attribution.
- `?sort=` — one of `id`, `document_name`, `type`, `document_date`, `creator`,
  `reviewer`, `status` (creator/reviewer sort on the user's email). Combine
  with `?order=asc|desc` (default `desc`). Without `sort`, the default
  recency ordering above applies.

Unknown sort columns, malformed status integers, and non-UUID
creator/reviewer values return `400`.

**Dates.** `documentDate` / `permitDate` / `recoveryDate` are date strings
(`YYYY-MM-DD`). `record.*` timestamps are returned as ISO-8601 UTC.

**Error shape.**

```jsonc
{ "message": "Validation failed", "errors": ["Address not found: …"] }  // 400
{ "message": "Write permission required" }                              // 403/404/etc.
```

| Status | When |
|---|---|
| 200 | Successful read, create, or returned-body update |
| 204 | Successful update / status change / delete (no body) |
| 400 | Body failed validation, or address could not be resolved |
| 401 | Missing/invalid credentials |
| 403 | Role too low, or reviewer == creator, or report in a read-only state |
| 404 | Report/sample not found in caller's org |
| 500 | Out-of-range enum integer, or unexpected server error |

---

## Document upload

Reports reference a previously uploaded source document. Upload first, then pass
the returned `name` as `documentFile`.

### `POST /api/inquiry/upload-document` · `POST /api/recovery/upload-document`

`multipart/form-data` with a single file field named **`input`**.

```bash
curl -X POST "$API/api/inquiry/upload-document" \
  -H "Authorization: Bearer $KEY" \
  -F 'input=@/path/report.pdf;type=application/pdf'
# 200 → { "name": "<uuid>.pdf" }
```

- **Allowed MIME types:** `application/pdf`, `image/png`, `image/jpeg`,
  `image/gif`, `image/bmp`, `image/tiff`, `image/webp`, `text/plain`.
- **Max size:** 128 MB. Empty files rejected.
- Inquiry docs are stored under `inquiry-report/`, recovery under
  `recovery-report/`. The returned `name` is the storage-key suffix; pass it as
  `documentFile`.
- Requires `writer`.

---

## Inquiry

`type` uses the **`inquiry_type`** enum (e.g. `1` = monitoring). Required body
fields on create/update: `documentName`, `documentDate`, `documentFile`,
`type`, `attribution.reviewer`, `attribution.contractor`.

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/inquiry` | member | 200 — list (paginated) |
| GET | `/api/inquiry/stats` | member | 200 — `{ "count": n }` for the org |
| GET | `/api/inquiry/{id}` | member | 200 — single inquiry |
| GET | `/api/inquiry/building/{building_id}` | member | 200 — inquiries with a sample on that building |
| GET | `/api/inquiry/{id}/download` | member | 200 — `{ "accessLink": "<1h signed URL>" }` |
| POST | `/api/inquiry` | writer | 200 — created inquiry (state `todo`) |
| PUT | `/api/inquiry/{id}` | writer | 204 — updated (rejected → resets to pending) |
| DELETE | `/api/inquiry/{id}` | superuser | 204 — deletes inquiry + samples + attribution |
| POST | `/api/inquiry/{id}/status_review` | writer | 204 — pending → pending_review (notifies reviewer) |
| POST | `/api/inquiry/{id}/status_approved` | verifier | 204 — pending_review → done |
| POST | `/api/inquiry/{id}/status_rejected` | verifier | 204 — pending_review → rejected |
| POST | `/api/inquiry/{id}/reset` | writer | 204 — unconditionally → pending |

**Create body:**

```jsonc
{
  "documentName": "Foundation survey at Kerkstraat 1",
  "documentDate": "2026-05-13",
  "documentFile": "<uuid>.pdf",       // from upload-document
  "type": 1,                          // inquiry_type
  "note": null,                       // optional
  "inspection": false,                // optional
  "jointMeasurement": false,          // optional
  "floorMeasurement": false,          // optional
  "standardF3o": false,               // optional
  "attribution": {
    "reviewer": "<uuid of a verifier/superuser in the org, ≠ you>",
    "contractor": 42                  // application.contractor FK; see GET /api/data/contractor
  }
}
```

`status_rejected` requires a body: `{ "message": "<non-empty motivation>" }`.

---

## Inquiry samples

A sample is one building's measurement record under an inquiry. `address` is an
input identifier that the server resolves to a canonical `(address, building)`
pair — you do not send `building`.

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/inquiry/{inquiry_id}/sample` | member | 200 — list (paginated) |
| GET | `/api/inquiry/{inquiry_id}/sample/stats` | member | 200 — `{ "count": n }` |
| GET | `/api/inquiry/{inquiry_id}/sample/{sample_id}` | member | 200 — single sample |
| POST | `/api/inquiry/{inquiry_id}/sample` | writer | 200 — created sample (inquiry → pending) |
| PUT | `/api/inquiry/{inquiry_id}/sample/{sample_id}` | writer | 204 — updated (inquiry → pending) |
| DELETE | `/api/inquiry/{inquiry_id}/sample/{sample_id}` | writer | 204 — deleting last sample → todo |

Sample writes require the parent inquiry to be in a **writable** state
(`todo` / `pending` / `rejected`); otherwise **403**.

**`address` accepts** (resolved server-side; whitespace-insensitive, BAG ids
upper-cased):
- FunderMaps internal id (`gfm-…`)
- BAG `NUMMERAANDUIDING` external id (e.g. `NL.IMBAG.NUMMERAANDUIDING.0344…`)
- BAG `PAND` id — resolves to one address per the address↔building N:1 mapping

An unresolvable `address` → **400**.

**Minimal create body** (only `address` is required; everything else optional):

```jsonc
{ "address": "NL.IMBAG.NUMMERAANDUIDING.0344200000000001" }
```

**Field reference** — all optional except `address`. Enum fields take the
integer from the [Enum reference](#enum-reference). "Level" fields are signed
depths in metres, range −999.99…999.99; "length" fields are non-negative sizes,
range 0…999.99. Out-of-range numerics → **400**.

| Field | Type | Notes |
|---|---|---|
| `address` | string | **required**; see resolution above |
| `note` | string | |
| `builtYear` | string | |
| `substructure` | enum int | `substructure` |
| `cpt` | string | CPT reference |
| `monitoringWell` | string | |
| `groundwaterLevelTemp` | level | |
| `groundLevel` | level | |
| `groundwaterLevelNet` | level | |
| `foundationType` | enum int | `foundation_type` |
| `enforcementTerm` | enum int | `enforcement_term` |
| `recoveryAdvised` | boolean | |
| `damageCause` | enum int | `foundation_damage_cause` |
| `damageCharacteristics` | enum int | `foundation_damage_characteristics` |
| `constructionPile` | enum int | `construction_pile` |
| `woodType` | enum int | `wood_type` |
| `woodEncroachment` | enum int | `wood_encroachment` |
| `constructionLevel`, `woodLevel` | level | |
| `pileDiameterTop`, `pileDiameterBottom` | length | |
| `pileHeadLevel`, `pileTipLevel` | level | |
| `foundationDepth` | length | |
| `masonLevel` | level | |
| `concreteChargerLength`, `pileDistanceLength`, `woodPenetrationDepth` | length | |
| `overallQuality` | enum int | `foundation_quality` |
| `woodQuality` | enum int | `wood_quality` |
| `constructionQuality`, `woodCapacityHorizontalQuality`, `pileWoodCapacityVerticalQuality`, `carryingCapacityQuality`, `masonQuality` | enum int | `quality` |
| `woodQualityNecessity` | boolean | |
| `crackIndoorRestored` | boolean | |
| `crackIndoorType` | enum int | `crack_type` |
| `crackIndoorSize` | int | |
| `crackFacade{Front,Back,Left,Right}Restored` | boolean | |
| `crackFacade{Front,Back,Left,Right}Type` | enum int | `crack_type` |
| `crackFacade{Front,Back,Left,Right}Size` | int | |
| `deformedFacade` | boolean | |
| `thresholdUpdownSkewed` | boolean | |
| `thresholdFrontLevel`, `thresholdBackLevel` | level | |
| `skewedParallel`, `skewedPerpendicular` | length | |
| `skewedParallelFacade`, `skewedPerpendicularFacade` | enum int | `rotation_type` |
| `settlementSpeed` | number | |
| `skewedWindowFrame` | boolean | |
| `facadeScanRisk` | enum int | `facade_scan_risk` |

---

## Recovery

Structurally identical to inquiry. `type` uses the **`recovery_document_type`**
enum (note: a *different* enum from inquiry's `type`). Required create/update
fields: `documentName`, `documentDate`, `documentFile`, `type`,
`attribution.reviewer`, `attribution.contractor`.

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/recovery` | member | 200 — list |
| GET | `/api/recovery/stats` | member | 200 — `{ "count": n }` |
| GET | `/api/recovery/{id}` | member | 200 — single recovery |
| GET | `/api/recovery/building/{building_id}` | member | 200 — recoveries on that building |
| GET | `/api/recovery/{id}/download` | member | 200 — `{ "accessLink": "…" }` |
| POST | `/api/recovery` | writer | 200 — created recovery (`todo`) |
| PUT | `/api/recovery/{id}` | writer | 204 |
| DELETE | `/api/recovery/{id}` | superuser | 204 |
| POST | `/api/recovery/{id}/status_review` | writer | 204 |
| POST | `/api/recovery/{id}/status_approved` | verifier | 204 |
| POST | `/api/recovery/{id}/status_rejected` | verifier | 204 (body `{ "message": "…" }`) |
| POST | `/api/recovery/{id}/reset` | writer | 204 |

**Create body:**

```jsonc
{
  "documentName": "Recovery permit — Kerkstraat 1",
  "documentDate": "2026-05-13",
  "documentFile": "<uuid>.pdf",
  "type": 1,                          // recovery_document_type (1 = foundation_report)
  "note": null,
  "attribution": { "reviewer": "<uuid ≠ you>", "contractor": 42 }
}
```

---

## Recovery samples

Recovery samples store **only a building** (no per-address row), so `address`
resolves to a BAG `PAND` building id. `type` is **required**
(`recovery_type`); everything else optional.

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/recovery/{recovery_id}/sample` | member | 200 — list |
| GET | `/api/recovery/{recovery_id}/sample/stats` | member | 200 — `{ "count": n }` |
| GET | `/api/recovery/{recovery_id}/sample/{sample_id}` | member | 200 — single |
| POST | `/api/recovery/{recovery_id}/sample` | writer | 200 — created (recovery → pending) |
| PUT | `/api/recovery/{recovery_id}/sample/{sample_id}` | writer | 204 (recovery → pending) |
| DELETE | `/api/recovery/{recovery_id}/sample/{sample_id}` | writer | 204 (last → todo) |

**Field reference:**

| Field | Type | Notes |
|---|---|---|
| `address` | string | **required**; resolved to building id |
| `type` | enum int | **required**; `recovery_type` |
| `note` | string | |
| `status` | enum int | `recovery_status` |
| `pileType` | enum int | `pile_type` |
| `facade` | array of enum int | `facade` (e.g. `[0,3]` = front + rear) |
| `permit` | string | permit reference |
| `permitDate` | date | `YYYY-MM-DD` |
| `recoveryDate` | date | `YYYY-MM-DD` |
| `contractor` | int | `application.contractor` FK |

---

## Audit-status state machine

`state.auditStatus` is returned as an integer (see `audit_status` enum). The
report progresses:

```
   todo ──first sample──▶ pending ──status_review──▶ pending_review ──status_approved──▶ done
    ▲                       ▲                              │
    └──delete last sample───┘                              └──status_rejected──▶ rejected ──edit (PUT)──▶ pending
                                                                                       ▲
                                                                                       └──reset──▶ pending
```

- Adding the first sample moves `todo → pending` automatically; deleting the
  last sample moves `pending → todo`.
- A report is editable only in `todo` / `pending` / `rejected`. Writing to a
  report in `pending_review` or `done` returns **403**.
- `PUT` on a `rejected` report resets it to `pending` for resubmission.
- `reset` forces `pending` from any state (writer convenience).
- Approve/reject require `pending_review`; an illegal transition → **400**.

Status transitions trigger notification emails (Mailgun) to the relevant
parties — `status_review` notifies the reviewer; approve/reject notify the
creator and reviewer. This is server-side; clients take no action. There is no
status webhook back to the provider — poll `GET /api/{inquiry|recovery}/{id}`
and read `state.auditStatus`.

---

## Enum reference

Integer ↔ meaning. Send the integer; gaps (e.g. `foundation_damage_cause` 7)
are intentional — do not send a missing value.

**`inquiry_type`** (inquiry `type`): 0 additional_research · 1 monitoring ·
2 note · 3 quickscan · 4 unknown · 5 demolition_research · 6 second_opinion ·
7 archive_research · 8 architectural_research · 9 foundation_advice ·
10 inspectionpit · 11 foundation_research · 12 ground_water_level_research ·
13 soil_investigation · 14 facade_scan

**`audit_status`** (`state.auditStatus`, read-only): 0 todo · 1 pending ·
2 done · 3 discarded · 4 pending_review · 5 rejected

**`recovery_document_type`** (recovery `type`): 0 permit · 1 foundation_report ·
2 archive_report · 3 owner_evidence · 4 unknown

**`recovery_status`**: 0 planned · 1 requested · 2 executed

**`recovery_type`**: 0 table · 1 beam_on_pile · 2 pile_lowering · 3 pile_in_wall ·
4 injection · 5 unknown

**`pile_type`**: 0 press · 1 internally_driven · 2 segment

**`facade`**: 0 front · 1 sidewall_left · 2 sidewall_right · 3 rear

**`substructure`**: 0 cellar · 1 basement · 2 crawlspace · 3 none

**`foundation_type`**: 0 wood · 1 wood_amsterdam · 2 wood_rotterdam · 3 concrete ·
4 no_pile · 5 no_pile_masonry · 6 no_pile_strips · 7 no_pile_bearing_floor ·
8 no_pile_concrete_floor · 9 no_pile_slit · 10 wood_charger · 11 weighted_pile ·
12 combined · 13 steel_pile · 14 other · 15 wood_rotterdam_amsterdam ·
16 wood_rotterdam_arch · 17 wood_amsterdam_arch

**`enforcement_term`**: 0 term05 · 1 term510 · 2 term1020 · 3 term5 · 4 term10 ·
5 term15 · 6 term20 · 7 term25 · 8 term30 · 9 term40

**`foundation_damage_cause`**: 0 drainage · 1 construction_flaw · 2 drystand ·
3 overcharge · 4 overcharge_negative_cling · 5 negative_cling · 6 bio_infection ·
*(7 absent)* · 8 fungus_infection · 9 bio_fungus_infection · 10 foundation_flaw ·
11 construction_heave · 12 subsidence · 13 vegetation · 14 gas · 15 vibrations ·
16 partial_foundation_recovery · 17 japanese_knotweed ·
18 groundwater_level_reduction

**`foundation_damage_characteristics`**: 0 jamming_door_window · 1 crack ·
2 skewed · 3 crawlspace_flooding · 4 threshold_above_subsurface ·
5 threshold_below_subsurface · 6 crooked_floor_wall

**`construction_pile`**: 0 punched · 1 broken · 2 pinched · 3 pressed ·
4 perished · 5 decay · 6 root_growth

**`wood_type`**: 0 pine · 1 spruce

**`wood_encroachment`**: 0 fungus_infection · 1 bio_fungus_infection ·
2 bio_infection

**`foundation_quality`** (`overallQuality`): 0 bad · 1 mediocre · 2 tolerable ·
3 good · 4 mediocre_good · 5 mediocre_bad

**`wood_quality`**: 0 area1 · 1 area2 · 2 area3 · 3 area4

**`quality`** (the `*Quality` fields except `overallQuality`/`woodQuality`):
0 nil · 1 small · 2 mediocre · 3 large

**`crack_type`**: 0 none · 1 nil · 2 small · 3 mediocre · 4 big

**`rotation_type`** (`skewed*Facade`): 0 nil · 1 small · 2 mediocre · 3 big ·
4 very_big

**`facade_scan_risk`**: 0 a · 1 b · 2 c · 3 d · 4 e

---

## End-to-end example (inquiry)

```bash
API=https://api.fundermaps.com
KEY=fmsk.…

# 1. Upload the source PDF
DOC=$(curl -s -X POST "$API/api/inquiry/upload-document" \
  -H "Authorization: Bearer $KEY" \
  -F 'input=@survey.pdf;type=application/pdf' | jq -r .name)

# 2. Create the inquiry (state: todo)
INQ=$(curl -s -X POST "$API/api/inquiry" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"documentName\":\"Kerkstraat 1\",\"documentDate\":\"2026-05-13\",
       \"documentFile\":\"$DOC\",\"type\":1,
       \"attribution\":{\"reviewer\":\"$REVIEWER_UUID\",\"contractor\":42}}" \
  | jq -r .id)

# 3. Add a sample (auto-transitions inquiry → pending)
curl -s -X POST "$API/api/inquiry/$INQ/sample" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"address":"NL.IMBAG.NUMMERAANDUIDING.0344200000000001",
       "foundationType":1,"groundLevel":-0.5,"constructionLevel":-1.2}'

# 4. Request review (pending → pending_review; emails the reviewer)
curl -s -X POST "$API/api/inquiry/$INQ/status_review" -H "Authorization: Bearer $KEY"

# 5. Poll for the verdict
curl -s "$API/api/inquiry/$INQ" -H "Authorization: Bearer $KEY" | jq '.state.auditStatus'
# 4 = pending_review, 2 = done, 5 = rejected
```

Recovery is the same flow with `/api/recovery`, recovery's `type` enum, and the
recovery-sample fields.

---

## Known gaps

- **No idempotency** — re-POSTing creates a duplicate. Dedupe client-side
  (cache the first 2xx keyed by your internal job id).
- **No per-key rate limit** configured today.
- **No per-building authorization** — a `writer` can submit against any
  building in the org. Scope at onboarding (separate user/key per project) if
  needed.
- **No status webhook** — poll the report's `state.auditStatus`.
