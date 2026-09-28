-- Phase 3: conversations and the ciphertext mailbox (docs/database.md §3, docs/messaging.md).
-- The mailbox stores opaque client ciphertext only, for at most MAILBOX_RETENTION_DAYS, and is
-- deleted earlier once every member has acknowledged it (ADR-010).
--
-- Phase 3 tracks delivery per *user*; per-device cursors replace this with device identities
-- in Phase 4/5 (ADR-034).

CREATE TABLE conversations (
  id                   uuid PRIMARY KEY,
  kind                 text NOT NULL CHECK (kind IN ('direct')),
  ciphersuite          integer NOT NULL CHECK (ciphersuite BETWEEN 0 AND 65535),
  epoch                bigint NOT NULL DEFAULT 0,
  last_seq             bigint NOT NULL DEFAULT 0,
  last_activity_at     timestamptz NOT NULL DEFAULT now(),
  -- Mirror of the (end-to-end protected) disappearing-message timer, used only so the server can
  -- delete ciphertext early.
  disappearing_seconds integer NOT NULL DEFAULT 0,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner', 'member')),
  acked_seq       bigint NOT NULL DEFAULT 0,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id) WHERE left_at IS NULL;

-- At most one direct conversation per pair of users (user_low < user_high).
CREATE TABLE direct_pairs (
  user_low        uuid NOT NULL,
  user_high       uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high)
);

CREATE TABLE mailbox_messages (
  conversation_id   uuid NOT NULL,
  seq               bigint NOT NULL,
  client_message_id uuid NOT NULL,
  sender_user_id    uuid NOT NULL,
  epoch             bigint NOT NULL,
  ciphertext        bytea NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, seq)
) PARTITION BY HASH (conversation_id);

CREATE TABLE mailbox_messages_p00 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 0);
CREATE TABLE mailbox_messages_p01 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 1);
CREATE TABLE mailbox_messages_p02 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 2);
CREATE TABLE mailbox_messages_p03 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 3);
CREATE TABLE mailbox_messages_p04 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 4);
CREATE TABLE mailbox_messages_p05 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 5);
CREATE TABLE mailbox_messages_p06 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 6);
CREATE TABLE mailbox_messages_p07 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 7);
CREATE TABLE mailbox_messages_p08 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 8);
CREATE TABLE mailbox_messages_p09 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 9);
CREATE TABLE mailbox_messages_p10 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 10);
CREATE TABLE mailbox_messages_p11 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 11);
CREATE TABLE mailbox_messages_p12 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 12);
CREATE TABLE mailbox_messages_p13 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 13);
CREATE TABLE mailbox_messages_p14 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 14);
CREATE TABLE mailbox_messages_p15 PARTITION OF mailbox_messages FOR VALUES WITH (MODULUS 16, REMAINDER 15);

-- Idempotency: a retried send with the same client id maps to the same row.
CREATE UNIQUE INDEX mailbox_messages_idempotency_key
  ON mailbox_messages (conversation_id, sender_user_id, client_message_id);
-- Retention sweeper.
CREATE INDEX mailbox_messages_expires_idx ON mailbox_messages (expires_at);
