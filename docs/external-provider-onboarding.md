# Onboarding an external data provider

External survey firms (the "providers") submit inquiry and recovery reports into a customer's FunderMaps tenant. This doc covers the provisioning steps a customer admin runs, and the end-to-end submission flow the provider runs.

> For the full endpoint reference (every route, field, enum value, and status code), see [`inquiry-recovery-api-reference.md`](inquiry-recovery-api-reference.md). This doc is the getting-started walkthrough.

> ⚠️ **Experimental.** The external-client API described here is still experimental and may change without notice. Coordinate with the FunderMaps team before building a production integration.

## Model

A provider is **a user in the customer's organization with the `writer` role**. They sign in with an API key (`fmsk.…`) and call the same `/api/inquiry/*` and `/api/recovery/*` endpoints the customer's own staff use. The customer's `verifier`/`superuser` reviews and approves; ownership stays with the customer org.

No separate provider tenant. No cross-org transfer. The customer admin is responsible for the relationship.

## Admin: provision the provider

All three steps run against the API as the customer admin (`administrator` global role).

```bash
API=https://api.fundermaps.com    # or your env
ADMIN_TOKEN=$(curl -s "$API/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@…","password":"…"}' | jq -r '.token')
```

### 1. Create the provider user

```bash
PROVIDER_ID=$(curl -s -X POST "$API/api/management/user" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"acme@provider.example","password":"<initial password>","name":"Acme Surveys BV"}' \
  | jq -r '.id')
```

This creates an `application.user` row with the global `user` role and a `credential` account so they can sign in via email/password. The provider can change their password later through the standard `/api/auth/*` flow.

### 2. Add them to the customer org with `writer` role

```bash
ORG_ID=<customer-org-uuid>
curl -s -X POST "$API/api/management/org/$ORG_ID/user" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"$PROVIDER_ID\",\"role\":\"writer\"}"
# → 201
```

Available org roles: `reader`, `writer`, `verifier`, `superuser`. Providers need `writer` — that's the minimum role gated by `assertCanWrite` (the helper that fronts every `/api/inquiry` and `/api/recovery` mutation).

### 3. Issue an API key

```bash
curl -s -X POST "$API/api/management/user/$PROVIDER_ID/api-key" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id, name, key}'
# → { "id": "…", "name": null, "key": "fmsk.…<64 chars>" }
```

**The plaintext `key` is returned exactly once at creation.** Store it securely and hand it to the provider; it cannot be recovered from the server side later.

Keys live in `application.apikey` (Better Auth `@better-auth/api-key` plugin). Revoke with `DELETE /api/management/user/$PROVIDER_ID/api-key` (body: `{"id": "<key id>"}`).

## Provider: submit an inquiry

Provider authenticates with `Authorization: Bearer fmsk.…` on every request. This header style works against both the API (`api.fundermaps.com`) and the Webservice (`ws.fundermaps.com`) — same key, same header.

```bash
KEY=fmsk.…
```

### 1. Upload the source document

```bash
curl -s -X POST "$API/api/inquiry/upload-document" \
  -H "Authorization: Bearer $KEY" \
  -F 'input=@/path/to/report.pdf;type=application/pdf' \
  | jq
# → { "name": "<uuid>.pdf" }
```

Constraints:
- Allowed MIME types: `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/bmp`, `image/tiff`, `image/webp`, `text/plain`.
- Max size: **128 MB**.
- The returned `name` is the storage key suffix; pass it as `documentFile` when creating the inquiry.

For recovery reports, the parallel endpoint is `POST /api/recovery/upload-document` (stores under the `recovery-report/` prefix).

### 2. Create the inquiry shell

```bash
curl -s -X POST "$API/api/inquiry" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "documentName": "Foundation survey at Kerkstraat 1",
    "documentDate": "2026-05-13",
    "documentFile": "<uuid>.pdf",
    "type": 1,
    "attribution": {
      "reviewer": "<UUID of a verifier/superuser in the customer org>",
      "contractor": <int FK into application.contractor>
    }
  }' | jq '{id, state}'
# → { "id": 120000, "state": { "auditStatus": 0 } }  (0 = todo)
```

Required:
- `reviewer` — UUID of a user in the same org with `verifier` or `superuser` role. The provider cannot be both creator and reviewer.
- `contractor` — integer FK; the customer admin should hand the provider the right id, or expose it via `/api/data/contractor`.
- `type` — integer enum (`inquiry_type`); 1 = `monitoring`, 2 = `note`, etc. See `report.inquiry_type` enum in the schema.

Optional booleans (`inspection`, `jointMeasurement`, `floorMeasurement`, `standardF3o`), `note`, etc. — see the Zod schema at `src/routes/inquiry.ts`.

The inquiry starts in `state.auditStatus = 0` (`todo`).

### 3. Attach samples (the actual measurement data)

```bash
curl -s -X POST "$API/api/inquiry/$INQ_ID/sample" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "address": "NL.IMBAG.NUMMERAANDUIDING.0344200000000001",
    "foundationType": 1,
    "groundLevel": -0.5,
    "constructionLevel": -1.2
    // … ~60 optional measurement fields, see src/routes/inquiry-sample.ts
  }' | jq '{id, address, building}'
```

`address` accepts any of:
- FunderMaps internal id (`gfm-…`)
- BAG `NUMMERAANDUIDING` external id
- BAG `PAND` (picks one address per the address↔building N:1 mapping)

The server resolves it to a canonical `(address_id, building_id)` pair before insert. Adding the first sample auto-transitions the inquiry from `todo` → `pending`.

### 4. Request review

```bash
curl -s -X POST "$API/api/inquiry/$INQ_ID/status_review" \
  -H "Authorization: Bearer $KEY"
# → 204
```

Transitions `pending` → `pending_review` and sends a Mailgun `report-reviewer` email to the assigned reviewer.

## Reviewer (customer side): approve or reject

A `verifier`/`superuser` in the same org calls:

```bash
# approve
curl -s -X POST "$API/api/inquiry/$INQ_ID/status_approved" -H "Authorization: Bearer $REVIEWER_KEY_OR_SESSION"
# → 204, sends report-approved email to creator + reviewer

# or reject with motivation
curl -s -X POST "$API/api/inquiry/$INQ_ID/status_rejected" \
  -H "Authorization: Bearer $REVIEWER_KEY_OR_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"message":"missing pile-tip depth on sample 3"}'
# → 204, sends report-declined email with motivation
```

A rejected inquiry can be edited (`PUT /api/inquiry/$INQ_ID`) which auto-transitions it back to `pending` for resubmission.

## Audit-status state machine

```
   todo ──first sample──▶ pending ──status_review──▶ pending_review ──status_approved──▶ done
    ▲                       ▲                       │
    └──delete last sample───┘                       └──status_rejected──▶ rejected ──edit──▶ pending
                                                                                  ▲
                                                                                  └──reset──▶ pending (unconditional)
```

Transition gates:
- `writer` role: create, edit (when state ∈ {`todo`, `pending`, `rejected`}), request review, reset.
- `verifier`/`superuser` role: approve, reject.
- `superuser` role: delete (cascades to attribution + samples).

## Recovery reports

Recovery is structurally identical — replace `/api/inquiry` with `/api/recovery` and `inquiry-report/` with `recovery-report/` in storage paths. Same role gates, same state machine, same Mailgun templates.

## Known gaps (today)

- **No idempotency**. Re-POSTing `/api/inquiry` creates a duplicate row. If your client retries on network failure, dedupe yourself (e.g. cache the first 2xx response keyed by your internal job id).
- **No per-key rate limit**. BA's apiKey plugin supports it but we don't configure it. A misbehaving provider can hammer the API; revoke the key if it happens.
- **No per-building authorization**. A writer in an org can submit inquiries against any building, not just buildings under a contract. If you need to restrict scope, do it at onboarding time (separate user / separate revocable key per project).
- **No webhook back to provider** on status change. Approval/rejection currently emails the provider's user; if they need a structured callback, they'd have to poll `GET /api/inquiry/$INQ_ID`.

These are deferred until a real customer flow needs them. Reopen the [Inquiry/recovery ingest API for external providers] item in the active backlog if so.
