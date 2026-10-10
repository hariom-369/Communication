-- Phase 11: abuse prevention and moderation (docs/moderation.md, ADR-021, ADR-049).
-- Private (end-to-end encrypted) content reaches Tessera only when a participant reports it; it
-- is stored encrypted to the moderation key (HPKE). Moderators see cases, never conversations.

-- Blocks (server-enforced: messages, calls, group adds, presence).
CREATE TABLE blocks (
  blocker_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id, created_at);

-- Staff (interim until the admin console with the corporate identity provider, Phase 12):
-- granted from the command line only, always with an expiry.
CREATE TABLE staff_roles (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('moderator', 'senior_moderator', 'legal')),
  granted_by  text NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 200),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, role)
);

-- Cases: one per subject and category while open; reports, grievances and legal orders attach.
CREATE TABLE moderation_cases (
  id                uuid PRIMARY KEY,
  subject_kind      text NOT NULL CHECK (subject_kind IN ('user', 'conversation', 'channel', 'post', 'comment', 'community', 'grievance')),
  subject_id        uuid NOT NULL,
  -- The channel of a reported post or comment.
  subject_parent_id uuid,
  subject_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  category          text NOT NULL,
  source            text NOT NULL CHECK (source IN ('report', 'grievance', 'legal_order', 'automated')),
  priority          smallint NOT NULL CHECK (priority BETWEEN 1 AND 4),
  status            text NOT NULL CHECK (status IN ('open', 'actioned', 'dismissed')),
  ack_due_at        timestamptz NOT NULL,
  due_at            timestamptz NOT NULL,
  acknowledged_at   timestamptz,
  resolved_at       timestamptz,
  assigned_to       uuid REFERENCES users (id) ON DELETE SET NULL,
  report_count      integer NOT NULL DEFAULT 0,
  breached_at       timestamptz,
  legal_hold        boolean NOT NULL DEFAULT false,
  opened_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_cases_queue_idx ON moderation_cases (status, due_at);
CREATE UNIQUE INDEX moderation_cases_open_subject_idx
  ON moderation_cases (subject_kind, subject_id, category) WHERE status = 'open';
CREATE INDEX moderation_cases_subject_user_idx ON moderation_cases (subject_user_id);

-- Append-only case timeline (reports, assignment, acknowledgement, evidence views, actions...).
CREATE TABLE moderation_case_events (
  id          uuid PRIMARY KEY,
  case_id     uuid NOT NULL REFERENCES moderation_cases (id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_case_events_case_idx ON moderation_case_events (case_id, created_at);

-- Evidence: E2EE report bundles stay encrypted to the moderation key (HPKE: enc + ciphertext);
-- server snapshots of public content are sealed with the server key ring. Hashes taken at
-- ingestion form the chain of custody.
CREATE TABLE moderation_evidence (
  id              uuid PRIMARY KEY,
  case_id         uuid NOT NULL REFERENCES moderation_cases (id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('e2ee_bundle', 'public_snapshot')),
  hpke_enc        bytea,
  sealed          bytea NOT NULL,
  sha256          bytea NOT NULL CHECK (length(sha256) = 32),
  plaintext_sha256 bytea CHECK (length(plaintext_sha256) = 32),
  size            integer NOT NULL,
  media_count     smallint NOT NULL DEFAULT 0,
  csam_match      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'e2ee_bundle') = (hpke_enc IS NOT NULL))
);
CREATE INDEX moderation_evidence_case_idx ON moderation_evidence (case_id);
CREATE INDEX moderation_evidence_created_idx ON moderation_evidence (created_at);

CREATE TABLE moderation_reports (
  id               uuid PRIMARY KEY,
  case_id          uuid NOT NULL REFERENCES moderation_cases (id) ON DELETE CASCADE,
  reporter_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  target_kind      text NOT NULL,
  target_id        uuid NOT NULL,
  category         text NOT NULL,
  details          text NOT NULL DEFAULT '' CHECK (length(details) <= 1000),
  evidence_id      uuid REFERENCES moderation_evidence (id) ON DELETE SET NULL,
  -- What the server could check: franked messages whose plaintext it verified (E2EE), or public
  -- content it captured itself.
  verification     text NOT NULL CHECK (verification IN ('content_verified', 'unverified', 'server_content', 'none')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_reports_case_idx ON moderation_reports (case_id);
CREATE INDEX moderation_reports_target_idx ON moderation_reports (target_kind, target_id, created_at);
CREATE UNIQUE INDEX moderation_reports_once_idx
  ON moderation_reports (reporter_id, target_kind, target_id, category);

-- Enforcement ladder: warn → restrict → suspend → ban; content and channel actions.
CREATE TABLE moderation_actions (
  id               uuid PRIMARY KEY,
  case_id          uuid NOT NULL REFERENCES moderation_cases (id) ON DELETE CASCADE,
  subject_user_id  uuid REFERENCES users (id) ON DELETE CASCADE,
  target_kind      text NOT NULL,
  target_id        uuid NOT NULL,
  action           text NOT NULL CHECK (action IN ('warn', 'restrict', 'suspend', 'ban', 'remove_content', 'channel_unlist', 'channel_suspend', 'legal_referral')),
  restriction      text CHECK (restriction IN ('new_chats', 'creation')),
  reason_code      text NOT NULL,
  note             text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  status           text NOT NULL CHECK (status IN ('pending_review', 'active', 'reverted', 'rejected')),
  starts_at        timestamptz NOT NULL DEFAULT now(),
  ends_at          timestamptz,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE INDEX moderation_actions_subject_idx ON moderation_actions (subject_user_id, status);
CREATE INDEX moderation_actions_case_idx ON moderation_actions (case_id);

CREATE TABLE moderation_appeals (
  id              uuid PRIMARY KEY,
  action_id       uuid NOT NULL REFERENCES moderation_actions (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  statement       text NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  status          text NOT NULL CHECK (status IN ('open', 'upheld', 'overturned')),
  reviewer_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  decision_reason text,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX moderation_appeals_once_idx ON moderation_appeals (action_id);

-- Grievances (IT Rules grievance officer) and legal orders, from anyone (not only users).
CREATE TABLE moderation_grievances (
  id           uuid PRIMARY KEY,
  case_id      uuid NOT NULL REFERENCES moderation_cases (id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  contact      text NOT NULL CHECK (length(contact) <= 254),
  kind         text NOT NULL CHECK (kind IN ('grievance', 'ncii', 'synthetic_media', 'court_order', 'government_order')),
  description  text NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  reference    text NOT NULL DEFAULT '' CHECK (length(reference) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Harmful link hosts (SHA-256 of the host; clients check by 4-byte prefix, k-anonymity).
CREATE TABLE link_blocklist (
  host        text PRIMARY KEY CHECK (length(host) BETWEEN 1 AND 253),
  host_hash   bytea NOT NULL UNIQUE CHECK (length(host_hash) = 32),
  category    text NOT NULL CHECK (category IN ('phishing', 'malware', 'scam', 'csam')),
  added_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Message franking (ADR-021): the sender's commitment and the server's tag over it, delivered
-- with the ciphertext. The tag needs no server-side record to be checked later.
ALTER TABLE mailbox_messages ADD COLUMN commitment bytea CHECK (length(commitment) = 32);
ALTER TABLE mailbox_messages ADD COLUMN franking_tag text CHECK (length(franking_tag) <= 100);

-- Moderation state of channels: unlisted (not in the directory) or suspended (readable by its
-- admins only, no posting). Set and cleared by moderation actions only.
ALTER TABLE channels ADD COLUMN moderation_state text NOT NULL DEFAULT 'ok'
  CHECK (moderation_state IN ('ok', 'unlisted', 'suspended'));

-- Known child-abuse media (exact SHA-256 of the file), managed by the legal role (L-12).
CREATE TABLE csam_hashes (
  sha256      bytea PRIMARY KEY CHECK (length(sha256) = 32),
  source      text NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  added_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL DEFAULT now()
);
