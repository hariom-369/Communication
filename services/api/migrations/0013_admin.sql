-- Phase 12: admin console (docs/admin.md, ADR-050). Staff are not Tessera user accounts: they
-- sign in with the corporate identity provider (OIDC) and a hardware-bound security key, on a
-- separate origin served by a separate process.

CREATE TABLE admin_users (
  id              uuid PRIMARY KEY,
  email           text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  -- Bound at the first sign-in (issuer + subject identify the person, not the email).
  oidc_issuer     text,
  oidc_subject    text,
  status          text NOT NULL CHECK (status IN ('active', 'disabled')),
  -- Elevated roles this person may request just in time (approved by another admin).
  eligible_roles  text[] NOT NULL DEFAULT '{}',
  created_by      text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz,
  UNIQUE (oidc_issuer, oidc_subject),
  CHECK ((oidc_issuer IS NULL) = (oidc_subject IS NULL))
);

-- Security keys (WebAuthn). Only hardware-bound (single-device) credentials are accepted.
CREATE TABLE admin_credentials (
  id             uuid PRIMARY KEY,
  admin_id       uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  credential_id  bytea NOT NULL UNIQUE,
  public_key     bytea NOT NULL,
  sign_count     bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  aaguid         text NOT NULL,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE INDEX admin_credentials_admin_idx ON admin_credentials (admin_id);

CREATE TABLE admin_sessions (
  id                  uuid PRIMARY KEY,
  admin_id            uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  token_digest        bytea NOT NULL UNIQUE CHECK (length(token_digest) = 32),
  -- `key`: identity provider done, security key still to come.
  stage               text NOT NULL CHECK (stage IN ('key', 'active')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  reauthenticated_at  timestamptz,
  revoked_at          timestamptz,
  ip_prefix           text NOT NULL,
  user_agent_summary  text NOT NULL
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id) WHERE revoked_at IS NULL;

-- Roles are always time-bound. Elevated roles (super_admin, security_admin) last at most 8 h.
CREATE TABLE admin_role_grants (
  id           uuid PRIMARY KEY,
  admin_id     uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('super_admin', 'security_admin', 'moderator', 'support_agent', 'analyst')),
  starts_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  -- The approved request it came from, or null for break-glass grants from the command line.
  approval_id  uuid,
  granted_by   text NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 200),
  revoked_at   timestamptz,
  CHECK (expires_at > starts_at)
);
CREATE INDEX admin_role_grants_admin_idx ON admin_role_grants (admin_id, expires_at);

-- Four-eyes: sensitive changes are requests that another admin must approve.
CREATE TABLE admin_approvals (
  id             uuid PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('role_grant', 'eligibility', 'admin_create', 'feature_flag', 'staff_role')),
  payload        jsonb NOT NULL,
  reason         text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  requested_by   uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by     uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  decided_at     timestamptz,
  decision_note  text NOT NULL DEFAULT '' CHECK (length(decision_note) <= 500),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX admin_approvals_pending_idx ON admin_approvals (status, requested_at);

-- Support tickets: every support view of a person's data is bound to one (purpose binding).
CREATE TABLE support_tickets (
  id               uuid PRIMARY KEY,
  reference        text NOT NULL CHECK (length(reference) BETWEEN 1 AND 100),
  subject_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason           text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  status           text NOT NULL CHECK (status IN ('open', 'closed')),
  created_by       uuid NOT NULL REFERENCES admin_users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);
CREATE INDEX support_tickets_subject_idx ON support_tickets (subject_user_id, status);

-- Feature flags, evaluated by the API per person (stable rollout buckets).
CREATE TABLE feature_flags (
  key              text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  description      text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('product', 'security')),
  enabled          boolean NOT NULL,
  rollout_percent  smallint NOT NULL CHECK (rollout_percent BETWEEN 0 AND 100),
  updated_by       uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO feature_flags (key, description, kind, enabled, rollout_percent) VALUES
  ('link_previews', 'Server-fetched link previews in channel posts', 'security', true, 100),
  ('group_calls', 'Group calls through the media server (SFU)', 'product', true, 100);
