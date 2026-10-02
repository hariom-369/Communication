-- Phase 7: end-to-end encrypted groups (docs/groups.md, ADR-044).
-- Group names, descriptions and pinned messages are end-to-end encrypted and never stored here.
-- Roles and settings are mirrored from the MLS-authenticated group policy so the server can
-- enforce its own API; clients enforce the authenticated copy themselves.

ALTER TABLE conversations DROP CONSTRAINT conversations_kind_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_kind_check CHECK (kind IN ('direct', 'group')),
  ADD COLUMN members_can_add boolean NOT NULL DEFAULT false,
  ADD COLUMN announcements_only boolean NOT NULL DEFAULT false,
  ADD COLUMN deleted_at timestamptz;

ALTER TABLE conversation_members DROP CONSTRAINT conversation_members_role_check;
ALTER TABLE conversation_members
  ADD CONSTRAINT conversation_members_role_check CHECK (role IN ('owner', 'admin', 'member')),
  ADD COLUMN added_by uuid;
-- At most one owner per conversation.
CREATE UNIQUE INDEX conversation_members_one_owner
  ON conversation_members (conversation_id) WHERE role = 'owner' AND left_at IS NULL;

-- A Welcome is the same bytes for every device it targets: store it once (a 256-member group
-- Welcome is ~120 KiB).
CREATE TABLE mls_welcome_payloads (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  welcome         bytea NOT NULL CHECK (octet_length(welcome) <= 1048576),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX mls_welcome_payloads_expires_idx ON mls_welcome_payloads (expires_at);
ALTER TABLE mls_welcomes
  ADD COLUMN payload_id uuid REFERENCES mls_welcome_payloads (id) ON DELETE CASCADE,
  ALTER COLUMN welcome DROP NOT NULL,
  ADD CONSTRAINT mls_welcomes_payload_check CHECK ((welcome IS NULL) <> (payload_id IS NULL));

-- Invitations for people whose privacy setting does not let this adder add them directly.
CREATE TABLE group_invitations (
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  invited_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX group_invitations_user_idx ON group_invitations (user_id);

-- Invite links: 128-bit random token, stored as a SHA-256 digest only.
CREATE TABLE group_links (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  token_digest    bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  max_uses        integer CHECK (max_uses BETWEEN 1 AND 10000),
  uses            integer NOT NULL DEFAULT 0,
  -- Shown to people who open the link before joining, only if an admin chose one. This is the
  -- one piece of group metadata the server can read (the real name is end-to-end encrypted).
  preview_title   text CHECK (char_length(preview_title) <= 80),
  revoked_at      timestamptz
);
CREATE INDEX group_links_conversation_idx ON group_links (conversation_id);

-- Joining through a link always asks an admin (whose device then adds the person).
CREATE TABLE group_join_requests (
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  link_id         uuid REFERENCES group_links (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE group_bans (
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  banned_by       uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
