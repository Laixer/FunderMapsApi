-- Migration: Add Better Auth support to application schema
-- Adds required columns to user table, creates session/account/verification tables

BEGIN;

-- Add Better Auth required columns to existing user table
ALTER TABLE application."user"
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now();

-- Backfill name from given_name + last_name
UPDATE application."user"
SET name = COALESCE(
  NULLIF(CONCAT_WS(' ', given_name, last_name), ''),
  email
);

-- Session table for Better Auth
CREATE TABLE IF NOT EXISTS application.session (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES application."user"(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamp NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_user_id ON application.session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_token ON application.session(token);

-- Account table for Better Auth (stores credentials per provider)
CREATE TABLE IF NOT EXISTS application.account (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES application."user"(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamp,
  refresh_token_expires_at timestamp,
  scope text,
  id_token text,
  password text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_user_id ON application.account(user_id);

-- Verification table for Better Auth (password reset, email verification tokens)
CREATE TABLE IF NOT EXISTS application.verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Migrate existing password hashes from user table to account table
-- Each existing user with a password gets a "credential" account
INSERT INTO application.account (id, user_id, account_id, provider_id, password)
SELECT
  gen_random_uuid()::text,
  id,
  id::text,
  'credential',
  password_hash
FROM application."user"
WHERE password_hash IS NOT NULL AND password_hash != ''
ON CONFLICT DO NOTHING;

-- Grant permissions to existing roles.
-- fundermaps owns the schema; fundermaps_webapp is the role the deployed
-- TS API connects as (sign-in flow needs SELECT on account, INSERT into
-- session, etc.). Without webapp grants every /api/auth call 500s with
-- "permission denied for table account" — discovered the hard way
-- 2026-04-25.
GRANT SELECT, INSERT, UPDATE, DELETE ON application.session TO fundermaps;
GRANT SELECT, INSERT, UPDATE, DELETE ON application.account TO fundermaps;
GRANT SELECT, INSERT, UPDATE, DELETE ON application.verification TO fundermaps;

GRANT SELECT, INSERT, UPDATE, DELETE ON application.session TO fundermaps_webapp;
GRANT SELECT, INSERT, UPDATE, DELETE ON application.account TO fundermaps_webapp;
GRANT SELECT, INSERT, UPDATE, DELETE ON application.verification TO fundermaps_webapp;

COMMIT;
