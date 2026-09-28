# Messaging and delivery semantics

Status: Phase 3 IMPLEMENTED (transport; E2EE in Phase 4) · Decisions: ADR-008, 009, 010, 020, 028, 036, 038 · Transport: [realtime.md](realtime.md)

## 0a. Phase 4 changes

- Payloads are MLS messages (ADR-004/041): `kind` = `application` (PrivateMessage) or `commit`
  (PublicMessage), attributed to the sending device (`senderDeviceId`, which must be one of the
  sender's active devices).
- Commits: `POST /api/v1/conversations/{id}/commits`, accepted only for the current epoch
  (compare-and-set, 409 otherwise); Welcomes are stored per target device
  (`GET /api/v1/welcomes`, `DELETE /api/v1/welcomes/{id}`).
- Application messages must use the conversation's current epoch; on 409 the client processes
  the new commit and re-encrypts.
- History is stored decrypted on the device (encrypted at rest) and shown from there; the
  server's copy is only for delivery. "Load earlier messages from the server" was removed.
- The development plaintext codec (ADR-038) is gone; ciphersuite 0 is rejected everywhere.

## 0. Phase 3 implementation status

Implemented in `services/api` (`messaging` module, migration `0003_messaging.sql`) and
`apps/web/src/messaging`:

- **Direct conversations** between two different users; opening one is idempotent
  (`direct_pairs`). Groups arrive in Phase 7.
- **Send**: `POST /api/v1/conversations/{id}/messages` `{clientMessageId, epoch, ciphersuite,
  ciphertext}` → `{seq, serverTime, duplicate}`. One transaction: membership check, idempotency
  on `(conversation, sender, clientMessageId)` (returns the original `seq`), epoch check,
  `seq = last_seq + 1` under `FOR UPDATE`, mailbox insert. Realtime events are published after
  commit. Ciphertext ≤ 64 KiB; body limit 96 KiB.
- **Payloads are opaque bytes** (`ciphertext bytea`); the server never parses them. The only
  Phase 3 codec is the development plaintext codec, triple-gated so it cannot reach staging or
  production (ADR-038).
- **Cursors are per user** in Phase 3 (`conversation_members.acked_seq`); per-device cursors
  replace them with device records (Phase 4/5). DELIVERED = every other member has acked the
  `seq`; READ = encrypted `read` control message, shown only when the viewer also shares read
  receipts (reciprocity).
- **Sync**: `GET /api/v1/sync` returns `{id, ackedSeq, lastSeq}` for every
  conversation; the client pages `GET …/messages?after=` in `seq` order and fills gaps when a
  pushed message skips ahead.
- **Operations** (reply, react, edit ≤ 15 min, delete for everyone ≤ 48 h, read markers) are
  control messages inside the payload; the rules are enforced by every client
  (`timeline.ts`), because the server cannot read them.
- **Disappearing messages**: the per-conversation timer is server-known and mirrored into each
  row's `expires_at`, so the sweeper deletes ciphertext on time even if clients are offline.
- **Retention**: rows are deleted when every member has acked them, or after 30 days
  (`MAILBOX_RETENTION_DAYS`), by a singleton sweeper (advisory lock) every 5 minutes.
- **Client outbox**: in memory in Phase 3; retries with full-jitter backoff (1 s → 60 s) using
  the same `clientMessageId`, marks FAILED on permanent errors or after 24 h, flushes on
  `online`. A persisted, encrypted outbox arrives with the encrypted local store (Phase 4).
- **Pagination**: conversation-list cursors are opaque base64url positions, not signed —
  tampering only moves the position inside the caller's own membership-filtered list. Message
  history uses `after`/`before` sequence numbers.
- Limits implemented: sends 300/min burst 20 per user; new direct conversations 60/h burst 20
  (fails closed); reads 600/min.

## 1. Delivery states

| State | Where tracked | Meaning | Server-visible? |
|---|---|---|---|
| SENDING | client | Encrypting / not yet handed to transport | No |
| QUEUED | client (encrypted local outbox) | Waiting for connectivity or retry | No |
| SENT | client, on server ack `{seq}` | Durably stored by server (synchronous commit, Multi-AZ) | Yes |
| DELIVERED | server: per-device `acked_seq`; relayed to sender as receipt event | At least one device of each recipient has fetched and acknowledged | Yes (inherent to routing) |
| READ | E2EE `ReadReceipt{up_to_seq}` message | Recipient opened the conversation (only if both parties enable read receipts) | **No** — encrypted |
| FAILED | client | Permanent failure (e.g. removed from group, blocked, payload rejected, retries exhausted after 24 h) | — |

Rules: states only move forward; each transition in UI is idempotent; FAILED offers
"retry" or "delete". Group message detail shows per-member delivered/read.

## 2. Send path

```
1. UI creates message_id (UUIDv7) + client_msg_id (same value) → SENDING
2. Worker encrypts (MLS PrivateMessage, current epoch) → store in local outbox → QUEUED
3. Transport: WS frame `msg.submit {conversation_id, client_msg_id, epoch, ciphertext}`
   (REST fallback POST /api/v1/conversations/{id}/messages with Idempotency-Key)
4. Server (single transaction):
   a. authz: session→device is an active member device of conversation; not blocked
      (for direct chats); group policy (announcements-only → admins); rate limits
   b. dedupe: if (sender_device_id, client_msg_id) exists → return existing seq (idempotent)
   c. epoch check: epoch == current or current-1 (grace window for in-flight commits)
   d. seq = ++last_seq; insert mailbox row; outbox event
5. Ack `msg.ack {client_msg_id, seq, server_ts}` → SENT
6. Outbox relay publishes `conv:{id}` event → realtime nodes push `msg.new` to online devices
7. Recipient device fetches/receives, decrypts, stores locally, sends `cursor.ack {conversation_id, seq}`
8. Server updates device_cursors; emits delivery receipt to sender devices when the first
   device of each recipient user acks → DELIVERED
```

Retries: exponential backoff with full jitter (1 s → 60 s cap), same `client_msg_id`
forever; ciphertext is **not** re-encrypted on retry unless the server returns
`EPOCH_TOO_OLD` (then re-encrypt under new epoch with the same message_id).

## 3. Receive / sync path

- On connect, client sends `sync.hello {cursors: [{conversation_id, acked_seq}…]}` (or a
  single global cursor over a per-device *change feed*, see below).
- **Per-device change feed**: `device_feed(device_id, feed_seq, conversation_id, seq)` is
  *not* stored per message (would multiply writes by device count). Instead the server
  computes "conversations with `last_seq > acked_seq`" for the device via
  `conversation_devices ⋈ conversations ⋈ device_cursors`; returned as a list of
  `(conversation_id, from_seq, to_seq)`; client then pages each with
  `GET /conversations/{id}/messages?after=<cursor>&limit=100`.
- Ordering: messages applied strictly in `seq` order per conversation; commits must be
  processed before later application messages of the new epoch (MLS requirement).
- Gap handling: if a pushed `msg.new` has `seq > local_last+1`, client fetches the gap first.

## 4. Offline delivery and retention

- Server keeps ciphertext until all current member devices have acked, or 30 days (ADR-010).
- A device that returns after >30 days receives `SYNC_TRUNCATED` with the earliest
  available seq; UI shows "Some messages couldn't be delivered to this device".
- If the device missed commits beyond what it can process (removed and re-added, or state
  lost), it is re-added by another member's device (fresh Welcome).

## 5. Pagination

Cursor-based, HMAC-signed, as specified in [database.md §5](database.md). History scrolling
beyond locally stored messages is not served by the server for E2EE chats (the server does
not retain it) — the UI shows the start of available history.

## 6. Message operations (all E2EE control messages)

| Operation | Rules |
|---|---|
| Reply / mention | Reference `message_id`; mentions include user IDs; notifications for mentions are generated **client-side** on recipient devices (server can't see mentions) |
| Reaction | One per user per message (latest wins); remove supported |
| Edit | Sender only, within 15 minutes; edit history kept locally; "edited" label |
| Delete for me | Local only (+ self-sync to own devices) |
| Delete for everyone | Sender within 48 h; admins in groups (any time, if group policy allows); recipients replace content with tombstone. Best-effort — cannot erase from a recipient's modified client |
| Disappearing messages | Timer options: off, 24 h, 7 d, 90 d; change announced in chat; applies to messages sent after the change |
| Polls | Poll definition + votes as E2EE messages; tallies computed client-side |
| Pinned messages | E2EE `Pin{message_id}`; server stores nothing |

## 7. Idempotency and deduplication summary

| Layer | Key |
|---|---|
| Server insert | `(sender_device_id, client_msg_id)` unique |
| REST | `Idempotency-Key` header = client_msg_id, 24 h retention |
| Client display | `message_id` inside ciphertext |
| MLS | generation reuse guard |

## 8. Limits (initial)

| Limit | Value |
|---|---|
| Ciphertext frame | 64 KiB (text; media via blobs) |
| Text length | 16,000 characters |
| Messages per device | 20/s burst, 300/min sustained; stricter for new accounts (see [moderation.md](moderation.md)) |
| New direct conversations per account | 50/day for accounts < 7 days old; 500/day otherwise |
| Group adds per commit | 100 devices |
