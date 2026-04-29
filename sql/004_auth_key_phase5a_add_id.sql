-- Migration: Phase 5a of API key hashing — add synthetic id column.
--
-- Additive only: adds an `id uuid` column with a per-row default so
-- existing rows are populated immediately. The plaintext `key` column
-- remains the PRIMARY KEY for now; the swap and DROP COLUMN happen in
-- Phase 5c, after the TS API and ManagementFront have been deployed
-- with code that no longer reads or writes the plaintext column.
--
-- No unique index on `id` here on purpose — Phase 5c's PRIMARY KEY (id)
-- will create one. gen_random_uuid() collisions in the brief gap are
-- not a real risk.

BEGIN;

ALTER TABLE application.auth_key
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();

COMMIT;
