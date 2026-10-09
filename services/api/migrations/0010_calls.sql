-- Phase 9: voice and video calls (docs/calling.md, ADR-016, ADR-017, ADR-047).
-- Call content and signalling never reach the server (they travel inside MLS messages). This is
-- the documented minimal record: who started it from which device, when, how it ended and how
-- many took part. Live participant rows exist only while someone is in the call.

CREATE TABLE calls (
  id                   uuid PRIMARY KEY,
  conversation_id      uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  mode                 text NOT NULL CHECK (mode IN ('p2p', 'sfu')),
  media                text NOT NULL CHECK (media IN ('audio', 'video')),
  initiator_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  initiator_device_id  uuid NOT NULL,
  started_at           timestamptz NOT NULL DEFAULT now(),
  answered_at          timestamptz,
  ended_at             timestamptz,
  end_reason           text CHECK (end_reason IN ('hangup', 'declined', 'busy', 'missed', 'failed', 'removed')),
  peak_participants    integer NOT NULL DEFAULT 1 CHECK (peak_participants >= 1),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
-- At most one live call per conversation; a second "start" joins it instead.
CREATE UNIQUE INDEX calls_live_idx ON calls (conversation_id) WHERE ended_at IS NULL;
CREATE INDEX calls_ended_idx ON calls (ended_at) WHERE ended_at IS NOT NULL;

CREATE TABLE call_participants (
  call_id       uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  device_id     uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, device_id)
);
CREATE INDEX call_participants_seen_idx ON call_participants (last_seen_at);
