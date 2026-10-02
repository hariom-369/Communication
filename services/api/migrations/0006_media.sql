-- Phase 6: end-to-end encrypted attachments (docs/media.md, ADR-043).
-- The server stores only metadata; blob bytes (client ciphertext) live in object storage and
-- move directly between browsers and the store through short-lived presigned URLs.

CREATE TABLE media_blobs (
  id           uuid PRIMARY KEY,
  owner_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Random key, never derived from user input.
  object_key   text NOT NULL UNIQUE CHECK (object_key ~ '^e2ee/[0-9a-f]{32}$'),
  -- Multipart upload id while uploading; null once complete.
  upload_id    text CHECK (char_length(upload_id) <= 1024),
  size         bigint NOT NULL CHECK (size > 0 AND size <= 268435456),
  part_size    integer NOT NULL CHECK (part_size >= 5242880),
  status       text NOT NULL CHECK (status IN ('uploading', 'ready')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- Unattached uploads expire after a day; attaching extends this to the message's expiry.
  expires_at   timestamptz NOT NULL,
  CHECK ((status = 'uploading') = (upload_id IS NOT NULL))
);
CREATE INDEX media_blobs_expires_idx ON media_blobs (expires_at);
CREATE INDEX media_blobs_owner_idx ON media_blobs (owner_id, created_at);

-- Which conversations reference a blob (the sender declares it when sending; docs/media.md §2).
-- Downloads require membership of a linked conversation. Reveals "this message has an
-- attachment of this size" to the server (docs/privacy.md).
CREATE TABLE media_links (
  blob_id         uuid NOT NULL REFERENCES media_blobs (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (blob_id, conversation_id)
);
CREATE INDEX media_links_conversation_idx ON media_links (conversation_id);
