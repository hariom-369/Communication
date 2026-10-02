-- Phase 7b: communities (docs/groups.md §5, ADR-045).
-- A community is a server-known container: its name, description, rules, roles and member list
-- are readable by the server (like a public profile). Its spaces are end-to-end encrypted groups
-- (conversations of kind 'group'), whose content the server never sees.

CREATE TABLE communities (
  id                    uuid PRIMARY KEY,
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 60),
  description           text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  visibility            text NOT NULL CHECK (visibility IN ('public', 'private')),
  rules                 text NOT NULL DEFAULT '' CHECK (char_length(rules) <= 4000),
  rules_version         integer NOT NULL DEFAULT 1,
  min_account_age_days  integer NOT NULL DEFAULT 0 CHECK (min_account_age_days BETWEEN 0 AND 365),
  owner_id              uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE INDEX communities_directory_idx ON communities (lower(name))
  WHERE visibility = 'public' AND deleted_at IS NULL;

-- Roles: a permission bitset, ordered by position (higher outranks lower).
CREATE TABLE community_roles (
  id            uuid PRIMARY KEY,
  community_id  uuid NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
  position      integer NOT NULL CHECK (position BETWEEN 1 AND 1000),
  permissions   integer NOT NULL CHECK (permissions BETWEEN 0 AND 63),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (community_id, name)
);

CREATE TABLE community_members (
  community_id    uuid NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  rules_version   integer NOT NULL,
  PRIMARY KEY (community_id, user_id)
);
CREATE INDEX community_members_user_idx ON community_members (user_id);

CREATE TABLE community_member_roles (
  community_id  uuid NOT NULL,
  user_id       uuid NOT NULL,
  role_id       uuid NOT NULL REFERENCES community_roles (id) ON DELETE CASCADE,
  PRIMARY KEY (community_id, user_id, role_id),
  FOREIGN KEY (community_id, user_id) REFERENCES community_members (community_id, user_id)
    ON DELETE CASCADE
);

CREATE TABLE community_bans (
  community_id  uuid NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  banned_by     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);

-- Invite links for (private or public) communities; token stored as a SHA-256 digest only.
CREATE TABLE community_links (
  id            uuid PRIMARY KEY,
  community_id  uuid NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
  token_digest  bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  max_uses      integer CHECK (max_uses BETWEEN 1 AND 100000),
  uses          integer NOT NULL DEFAULT 0,
  revoked_at    timestamptz
);
CREATE INDEX community_links_community_idx ON community_links (community_id);

-- Spaces: end-to-end encrypted groups that belong to a community. The space name is listed to
-- members before they join, so it is server-readable; the group's own name stays encrypted.
CREATE TABLE community_spaces (
  conversation_id  uuid PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  community_id     uuid NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  -- An admin device approves join requests from eligible members automatically.
  auto_approve     boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (community_id, name)
);
CREATE INDEX community_spaces_community_idx ON community_spaces (community_id);

-- A space restricted to roles: only members holding one of them may join.
CREATE TABLE community_space_roles (
  conversation_id  uuid NOT NULL REFERENCES community_spaces (conversation_id) ON DELETE CASCADE,
  role_id          uuid NOT NULL REFERENCES community_roles (id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, role_id)
);
