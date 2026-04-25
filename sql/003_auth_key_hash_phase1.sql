-- Migration: Phase 1 of API key hashing — additive schema only.
--
-- Adds key_hash, expires_at, created_at, updated_at columns to auth_key.
-- Plaintext `key` column and PRIMARY KEY untouched. No code reads
-- key_hash yet; backfill happens via a separate TS script
-- (scripts/backfill_auth_key_hash.ts) so the DB never hashes anything.
--
-- key_hash is intentionally left NULLABLE in this phase — a NOT NULL
-- constraint would block legitimate INSERTs that come from any code
-- path not yet aware of the new column (e.g. the TS API today, before
-- Phase 2 is deployed). The constraint will be added at the end of
-- Phase 2, once all writers populate both columns.
--
-- The unique index on key_hash IS safe to add here: PostgreSQL's
-- UNIQUE allows multiple NULLs, so existing rows (NULL until backfill)
-- don't conflict, and once backfilled the index doubles as the
-- lookup index used by Phase 3 read-path.

BEGIN;

ALTER TABLE application.auth_key
  ADD COLUMN IF NOT EXISTS key_hash text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Defaults apply only to NEW rows. Existing 26 rows stay NULL — we
-- have no record of when those keys were originally issued and
-- backfilling now() would lie about history.
ALTER TABLE application.auth_key
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

-- Unique index on key_hash. NULLs allowed (multiple), so safe pre-
-- backfill. Becomes the auth lookup index in Phase 3.
CREATE UNIQUE INDEX IF NOT EXISTS auth_key_key_hash_idx
  ON application.auth_key (key_hash);

-- Partial index — cheap "find expiring soon" queries without
-- bloating the index for the (current) common case where every
-- key has expires_at = NULL.
CREATE INDEX IF NOT EXISTS auth_key_expires_at_idx
  ON application.auth_key (expires_at)
  WHERE expires_at IS NOT NULL;

COMMIT;
