-- Phase 5: multiple devices per account, device linking and encrypted backups
-- (docs/multi-device.md, docs/encrypted-backups.md).

-- Informational device metadata shown in device lists. `trusted` is what the device declared
-- (it holds the account identity key); the server cannot verify it and never relies on it.
ALTER TABLE devices
  ADD COLUMN label text NOT NULL DEFAULT 'Unknown device' CHECK (char_length(label) <= 80),
  ADD COLUMN trusted boolean NOT NULL DEFAULT true;

-- Short-lived link requests: a new device publishes its ephemeral HPKE key and MLS signature
-- key; an existing device of the same account relays an HPKE-sealed payload back.
CREATE TABLE link_sessions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id       uuid NOT NULL,
  short_id         bytea NOT NULL CHECK (octet_length(short_id) = 5),
  device_id        uuid NOT NULL,
  hpke_public      bytea NOT NULL CHECK (octet_length(hpke_public) = 32),
  signature_public bytea NOT NULL CHECK (octet_length(signature_public) = 32),
  label            text NOT NULL CHECK (char_length(label) <= 80),
  sealed           bytea CHECK (octet_length(sealed) <= 8388608),
  approved_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX link_sessions_short_id ON link_sessions (user_id, short_id);
CREATE INDEX link_sessions_expires_idx ON link_sessions (expires_at);

-- Encrypted backups (ciphertext only; the server never holds a key that opens them).
CREATE TABLE backups (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  version    bigint NOT NULL CHECK (version >= 1),
  blob       bytea NOT NULL CHECK (octet_length(blob) <= 33554432),
  manifest   text NOT NULL CHECK (char_length(manifest) <= 2048),
  mac        bytea NOT NULL CHECK (octet_length(mac) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, version)
);

-- The Backup Root Key wrapped under a recovery key or a passkey's PRF output.
CREATE TABLE backup_wraps (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('recovery', 'passkey')),
  wrap          bytea NOT NULL CHECK (octet_length(wrap) = 72),
  credential_id text CHECK (char_length(credential_id) <= 1024),
  prf_salt      bytea CHECK (octet_length(prf_salt) = 32),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'passkey') = (credential_id IS NOT NULL AND prf_salt IS NOT NULL))
);
CREATE INDEX backup_wraps_user_idx ON backup_wraps (user_id);
