-- Phase 2: accounts, credentials, sessions, audit (docs/database.md §3, docs/authentication.md).
-- Secrets are never stored in plaintext: passwords are Argon2id (peppered), tokens and codes are
-- SHA-256 / HMAC digests, TOTP secrets are AES-256-GCM encrypted by the application.

-- accounts module --------------------------------------------------------------------------

CREATE TABLE users (
  id                 uuid PRIMARY KEY,
  username           citext NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending_verification', 'pending_credential', 'active')),
  accepted_terms_version text NOT NULL,
  confirmed_adult_at timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (username);

CREATE TABLE user_emails (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  email       citext NOT NULL,
  verified_at timestamptz
);
CREATE UNIQUE INDEX user_emails_email_key ON user_emails (email);

CREATE TABLE email_verifications (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_digest bytea NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verifications_user_idx ON email_verifications (user_id, created_at DESC);

CREATE TABLE privacy_settings (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  settings   jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- auth module ------------------------------------------------------------------------------

CREATE TABLE password_credentials (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  hash       text NOT NULL,          -- Argon2id PHC string over HMAC(pepper, password)
  pepper_id  text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkeys (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id  bytea NOT NULL,
  public_key     bytea NOT NULL,
  sign_count     bigint NOT NULL,
  transports     text[] NOT NULL DEFAULT '{}',
  backup_eligible boolean NOT NULL,
  backup_state   boolean NOT NULL,
  name           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE UNIQUE INDEX passkeys_credential_id_key ON passkeys (credential_id);
CREATE INDEX passkeys_user_idx ON passkeys (user_id);

CREATE TABLE totp_credentials (
  user_id          uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret_encrypted text NOT NULL,     -- SecretBox envelope (key id + AES-256-GCM)
  confirmed_at     timestamptz,
  last_used_step   bigint,            -- replay protection
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recovery_codes (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_digest bytea NOT NULL,
  used_at     timestamptz
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_digest       bytea NOT NULL,
  stage              text NOT NULL CHECK (stage IN ('credential_setup', 'mfa_pending', 'active')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  idle_expires_at    timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  reauthenticated_at timestamptz,
  user_agent_summary text NOT NULL,
  ip_prefix          text NOT NULL,
  revoked_at         timestamptz,
  revoke_reason      text
);
CREATE UNIQUE INDEX sessions_token_digest_key ON sessions (token_digest);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_resets (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_digest bytea NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX password_resets_token_digest_key ON password_resets (token_digest);

-- Security events used for suspicious-login detection. Retained 180 days (CERT-In, L-08).
CREATE TABLE login_events (
  id                 uuid PRIMARY KEY,
  user_id            uuid REFERENCES users (id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('success', 'failure', 'mfa_failure')),
  method             text NOT NULL CHECK (method IN ('password', 'passkey', 'mfa', 'recovery_code')),
  ip_prefix          text NOT NULL,
  user_agent_summary text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_events_user_idx ON login_events (user_id, created_at DESC);
CREATE INDEX login_events_created_idx ON login_events (created_at);

-- audit module -----------------------------------------------------------------------------

-- Append-only and hash-chained (docs/security.md §11): each row's hash covers the previous
-- row's hash, so deleting or editing a row breaks verification from that point on.
CREATE TABLE audit_log (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id          uuid NOT NULL,
  at          timestamptz NOT NULL,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('user', 'system', 'admin')),
  actor_id    uuid,
  action      text NOT NULL,
  target_kind text,
  target_id   uuid,
  request_id  uuid,
  details     jsonb NOT NULL DEFAULT '{}',
  prev_hash   bytea NOT NULL,
  hash        bytea NOT NULL
);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, at DESC);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
