-- Phase 10: notifications (docs/notifications.md, ADR-048).
-- Push subscriptions belong to one browser session and one encryption device: they stop being
-- used the moment either ends, and are deleted with the session. Nothing here holds message
-- content; pushes only name the conversation that has something new.

CREATE TABLE push_subscriptions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  device_id        uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  endpoint         text NOT NULL UNIQUE CHECK (length(endpoint) <= 1024),
  p256dh           bytea NOT NULL CHECK (length(p256dh) = 65),
  auth             bytea NOT NULL CHECK (length(auth) = 16),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_success_at  timestamptz,
  failures         smallint NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
-- One subscription per session (a browser re-subscribing replaces its old endpoint).
CREATE UNIQUE INDEX push_subscriptions_session_idx ON push_subscriptions (session_id);

-- Absent row = defaults (everything on, no quiet hours).
CREATE TABLE notification_preferences (
  user_id             uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  messages            boolean NOT NULL,
  calls               boolean NOT NULL,
  channel_posts       boolean NOT NULL,
  quiet_start         smallint CHECK (quiet_start BETWEEN 0 AND 1439),
  quiet_end           smallint CHECK (quiet_end BETWEEN 0 AND 1439),
  quiet_time_zone     text CHECK (length(quiet_time_zone) <= 64),
  quiet_allow_calls   boolean NOT NULL DEFAULT true,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL) AND (quiet_start IS NULL) = (quiet_time_zone IS NULL))
);

-- Muted conversations; muted_until NULL = until unmuted.
CREATE TABLE conversation_mutes (
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  muted_until      timestamptz,
  PRIMARY KEY (user_id, conversation_id)
);

-- Account security alerts, shown in the app on every device (they cannot be turned off).
CREATE TABLE security_alerts (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  headline    text NOT NULL CHECK (length(headline) <= 200),
  details     jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX security_alerts_user_idx ON security_alerts (user_id, id DESC);
CREATE INDEX security_alerts_created_idx ON security_alerts (created_at);

-- Channel post notifications are opt-in per subscription.
ALTER TABLE channel_subscribers ADD COLUMN notify boolean NOT NULL DEFAULT false;
CREATE INDEX channel_subscribers_notify_idx ON channel_subscribers (channel_id, user_id) WHERE notify;
