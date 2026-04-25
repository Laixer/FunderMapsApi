-- Migration: Add Better Auth OIDC provider tables
-- Enables Better Auth to act as an OIDC/OAuth2 authorization server
-- (used to replace the Go custom OAuth2 server for Grafana SSO).

BEGIN;

-- JWKS — signing keypairs used by the `jwt` plugin to sign ID tokens
-- and JWT access tokens. The plugin auto-creates a key on first start
-- if the table is empty.
CREATE TABLE IF NOT EXISTS application.jwks (
  id text PRIMARY KEY,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp
);

-- OAuth2/OIDC client registrations (e.g. Grafana). client_id is the
-- public client identifier; client_secret is hashed at rest by Better
-- Auth before insert. type ∈ ('web','native','user-agent-based','public').
CREATE TABLE IF NOT EXISTS application.oauth_application (
  id text PRIMARY KEY,
  name text NOT NULL,
  icon text,
  metadata text,
  client_id text NOT NULL UNIQUE,
  client_secret text,
  redirect_urls text NOT NULL,
  type text NOT NULL,
  disabled boolean DEFAULT false,
  user_id uuid REFERENCES application."user"(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_application_user_id
  ON application.oauth_application(user_id);

-- Issued access + refresh tokens. One row per token pair.
CREATE TABLE IF NOT EXISTS application.oauth_access_token (
  id text PRIMARY KEY,
  access_token text NOT NULL UNIQUE,
  refresh_token text NOT NULL UNIQUE,
  access_token_expires_at timestamp NOT NULL,
  refresh_token_expires_at timestamp NOT NULL,
  client_id text NOT NULL REFERENCES application.oauth_application(client_id) ON DELETE CASCADE,
  user_id uuid REFERENCES application."user"(id) ON DELETE CASCADE,
  scopes text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_access_token_client_id
  ON application.oauth_access_token(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_token_user_id
  ON application.oauth_access_token(user_id);

-- Per-user consent records — set once when a user first authorizes a
-- given client + scope set. Lets the plugin skip the consent screen on
-- subsequent flows.
CREATE TABLE IF NOT EXISTS application.oauth_consent (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES application.oauth_application(client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES application."user"(id) ON DELETE CASCADE,
  scopes text NOT NULL,
  consent_given boolean NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_consent_client_id
  ON application.oauth_consent(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_user_id
  ON application.oauth_consent(user_id);

-- Grants: the deployed TS API connects as fundermaps_webapp, so it
-- needs full DML on these tables (otherwise every /api/auth/oauth2/*
-- call 500s with "permission denied"). Same lesson as 001.
GRANT SELECT, INSERT, UPDATE, DELETE ON application.jwks TO fundermaps;
GRANT SELECT, INSERT, UPDATE, DELETE ON application.oauth_application TO fundermaps;
GRANT SELECT, INSERT, UPDATE, DELETE ON application.oauth_access_token TO fundermaps;
GRANT SELECT, INSERT, UPDATE, DELETE ON application.oauth_consent TO fundermaps;

GRANT SELECT, INSERT, UPDATE, DELETE ON application.jwks TO fundermaps_webapp;
GRANT SELECT, INSERT, UPDATE, DELETE ON application.oauth_application TO fundermaps_webapp;
GRANT SELECT, INSERT, UPDATE, DELETE ON application.oauth_access_token TO fundermaps_webapp;
GRANT SELECT, INSERT, UPDATE, DELETE ON application.oauth_consent TO fundermaps_webapp;

COMMIT;
