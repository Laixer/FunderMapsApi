-- Migration: Phase 5c of API key hashing — drop plaintext key column.
--
-- Run only after the TS API + ManagementFront commits that stop reading
-- and writing the plaintext column have deployed (Phase 5b). The
-- destructive operations:
--
--   1. Refuse to run if any row still has NULL key_hash — those rows
--      are the only ones that would become unauthable after the column
--      is gone.
--   2. Swap PRIMARY KEY from (key) to (id). Drops auth_key_pkey on key,
--      adds it on id (added in Phase 5a, populated for all rows).
--   3. Promote key_hash to NOT NULL. Auth depends on it everywhere
--      (TS API, TS Webservice, C# Webservice, all hash-only as of
--      Phase 4.5 deployed 2026-04-26). The Phase 1 unique index stays.
--   4. DROP COLUMN key. The DEFAULT (random_string) and NOT NULL go
--      with it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM application.auth_key WHERE key_hash IS NULL) THEN
    RAISE EXCEPTION 'application.auth_key has rows with NULL key_hash — run scripts/backfill_auth_key_hash.ts first';
  END IF;
END $$;

ALTER TABLE application.auth_key DROP CONSTRAINT auth_key_pkey;
ALTER TABLE application.auth_key ADD PRIMARY KEY (id);

ALTER TABLE application.auth_key ALTER COLUMN key_hash SET NOT NULL;

ALTER TABLE application.auth_key DROP COLUMN key;

COMMIT;
