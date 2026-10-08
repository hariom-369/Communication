-- Phase 8: broadcast channels (docs/channels.md, ADR-012, ADR-046).
-- Channels are NOT end-to-end encrypted: posts, comments and reactions are server-protected so
-- that they can be delivered to any number of subscribers, searched and moderated.

CREATE TABLE channels (
  id                 uuid PRIMARY KEY,
  handle             text NOT NULL CHECK (handle ~ '^[a-z0-9_]{3,32}$'),
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description        text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  visibility         text NOT NULL CHECK (visibility IN ('public', 'private')),
  comments_enabled   boolean NOT NULL DEFAULT true,
  slow_mode_seconds  integer NOT NULL DEFAULT 0 CHECK (slow_mode_seconds BETWEEN 0 AND 3600),
  owner_id           uuid NOT NULL REFERENCES users (id),
  last_post_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX channels_handle_idx ON channels (handle) WHERE deleted_at IS NULL;
CREATE INDEX channels_directory_idx ON channels (lower(title)) WHERE visibility = 'public' AND deleted_at IS NULL;

-- Admins other than the owner, with a permission bitset (docs/channels.md §3).
CREATE TABLE channel_admins (
  channel_id   uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permissions  integer NOT NULL CHECK (permissions BETWEEN 1 AND 127),
  added_by     uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_admins_user_idx ON channel_admins (user_id);

-- Ownership changes take effect after a cooling-off period, so a stolen session cannot take a
-- channel instantly; the owner can cancel during that time.
CREATE TABLE channel_ownership_transfers (
  channel_id    uuid PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  to_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  requested_by  uuid NOT NULL,
  effective_at  timestamptz NOT NULL
);

-- Subscribers. Publishing never touches this table (fan-out on read).
CREATE TABLE channel_subscribers (
  channel_id  uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_subscribers_user_idx ON channel_subscribers (user_id);

-- Subscriber count, sharded so that a popular channel's counter is not one hot row.
CREATE TABLE channel_subscriber_counts (
  channel_id  uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  shard       smallint NOT NULL CHECK (shard BETWEEN 0 AND 15),
  count       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, shard)
);

-- Daily joins and leaves, for growth analytics (aggregates only).
CREATE TABLE channel_subscriber_daily (
  channel_id  uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  day         date NOT NULL,
  shard       smallint NOT NULL CHECK (shard BETWEEN 0 AND 15),
  joined      integer NOT NULL DEFAULT 0,
  left_count  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, day, shard)
);

CREATE TABLE channel_posts (
  id             uuid PRIMARY KEY,
  channel_id     uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  author_id      uuid NOT NULL,
  status         text NOT NULL CHECK (status IN ('draft', 'scheduled', 'published', 'removed')),
  body           text NOT NULL CHECK (char_length(body) <= 4096),
  -- Server-fetched preview of a link in the post (the server never trusts a client's preview).
  preview_url    text CHECK (char_length(preview_url) <= 2048),
  preview        jsonb,
  publish_at     timestamptz,
  published_at   timestamptz,
  edited_at      timestamptz,
  removed_at     timestamptz,
  removed_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  search         tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
  CHECK ((status = 'scheduled') = (publish_at IS NOT NULL)),
  CHECK ((status = 'published') <= (published_at IS NOT NULL))
);
CREATE INDEX channel_posts_feed_idx ON channel_posts (channel_id, published_at DESC, id DESC)
  WHERE status = 'published';
CREATE INDEX channel_posts_due_idx ON channel_posts (publish_at) WHERE status = 'scheduled';
CREATE INDEX channel_posts_search_idx ON channel_posts USING gin (search) WHERE status = 'published';

-- Polls: server-side tallies; anonymous polls never expose who voted for what.
CREATE TABLE channel_polls (
  post_id    uuid PRIMARY KEY REFERENCES channel_posts (id) ON DELETE CASCADE,
  question   text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  options    jsonb NOT NULL,
  multiple   boolean NOT NULL,
  anonymous  boolean NOT NULL
);
CREATE TABLE channel_poll_votes (
  post_id     uuid NOT NULL REFERENCES channel_polls (post_id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  option      smallint NOT NULL CHECK (option BETWEEN 0 AND 9),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, option)
);

CREATE TABLE channel_reactions (
  post_id     uuid NOT NULL REFERENCES channel_posts (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji       text NOT NULL CHECK (char_length(emoji) <= 16),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE channel_reaction_counts (
  post_id  uuid NOT NULL REFERENCES channel_posts (id) ON DELETE CASCADE,
  emoji    text NOT NULL,
  count    bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (post_id, emoji)
);

CREATE TABLE channel_comments (
  id          uuid PRIMARY KEY,
  post_id     uuid NOT NULL REFERENCES channel_posts (id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  removed_by  uuid
);
CREATE INDEX channel_comments_post_idx ON channel_comments (post_id, created_at, id);
CREATE INDEX channel_comments_author_idx ON channel_comments (author_id, created_at);

-- Daily unique viewers per post, rolled up from Valkey HyperLogLogs (no per-viewer rows).
CREATE TABLE channel_post_views (
  post_id  uuid NOT NULL REFERENCES channel_posts (id) ON DELETE CASCADE,
  day      date NOT NULL,
  views    bigint NOT NULL,
  PRIMARY KEY (post_id, day)
);

CREATE TABLE channel_links (
  id            uuid PRIMARY KEY,
  channel_id    uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  token_digest  bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  max_uses      integer CHECK (max_uses BETWEEN 1 AND 1000000),
  uses          integer NOT NULL DEFAULT 0,
  revoked_at    timestamptz
);
CREATE INDEX channel_links_channel_idx ON channel_links (channel_id);
