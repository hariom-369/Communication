-- Phase 4: end-to-end encryption (docs/crypto-design.md, docs/e2ee.md).
-- Key directory (public material only) and the MLS delivery-service additions.

-- Development-only unencrypted conversations (Phase 3, ciphersuite 0) must not survive into an
-- E2EE deployment. The mailbox is partitioned without a foreign key, so clean it explicitly.
DELETE FROM mailbox_messages
  WHERE conversation_id IN (SELECT id FROM conversations WHERE ciphersuite = 0);
DELETE FROM conversations WHERE ciphersuite = 0;
ALTER TABLE conversations ADD CONSTRAINT conversations_ciphersuite_protected CHECK (ciphersuite > 0);

-- Account Signing Key (Ed25519 public key) per user; `version` increases on identity reset.
CREATE TABLE account_keys (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
  version    integer NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A device is a cryptographic identity: its MLS signature key certified by the user's ASK.
CREATE TABLE devices (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ask_version   integer NOT NULL CHECK (ask_version >= 1),
  signature_key bytea NOT NULL CHECK (octet_length(signature_key) = 32),
  certificate   bytea NOT NULL CHECK (octet_length(certificate) <= 256),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX devices_active_user_idx ON devices (user_id) WHERE revoked_at IS NULL;

-- MLS KeyPackages (opaque to the server). One-time packages are consumed on claim; the
-- last-resort package is returned when none remain and is never consumed (RFC 9420 §16.8).
CREATE TABLE key_packages (
  id          uuid PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  key_package bytea NOT NULL CHECK (octet_length(key_package) <= 4096),
  last_resort boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX key_packages_claim_idx ON key_packages (device_id, created_at) WHERE NOT last_resort;
CREATE UNIQUE INDEX key_packages_one_last_resort ON key_packages (device_id) WHERE last_resort;
CREATE INDEX key_packages_expires_idx ON key_packages (expires_at);

-- Mailbox rows are now MLS messages: application (PrivateMessage) or commit (PublicMessage),
-- attributed to the sending device.
ALTER TABLE mailbox_messages
  ADD COLUMN kind smallint NOT NULL DEFAULT 1 CHECK (kind IN (1, 2)),
  ADD COLUMN sender_device_id uuid;
ALTER TABLE mailbox_messages ALTER COLUMN kind DROP DEFAULT;

-- Welcomes waiting for a device (ADR-009 §4): deleted when the device acknowledges them.
CREATE TABLE mls_welcomes (
  id               uuid PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  target_user_id   uuid NOT NULL,
  target_device_id uuid NOT NULL,
  commit_seq       bigint NOT NULL,
  welcome          bytea NOT NULL CHECK (octet_length(welcome) <= 65536),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX mls_welcomes_device_idx ON mls_welcomes (target_device_id, created_at);
CREATE INDEX mls_welcomes_expires_idx ON mls_welcomes (expires_at);
