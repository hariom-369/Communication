# Realtime (WebSocket) architecture

Status: Phase 3 IMPLEMENTED (subset, see §0) · Decisions: ADR-001, 015, 020, 029, 033, 036, 037

## 0. Phase 3 implementation status

What `services/realtime` does today, and where it differs from the target design below:

| Area | Phase 3 | Target (sections below) |
|---|---|---|
| Endpoint | `wss://<web origin>/rt/v1/ws` (ADR-033 amendment) | same |
| Auth | `POST /api/v1/realtime/ticket` → 256-bit ticket, 30 s, single use (`GETDEL`), bound to the session; `auth` frame within 5 s (else 4401); session re-checked every 60 s and on `sessions_changed` | + bound to device (Phase 4) |
| Origin | allow-list checked before the upgrade (403 otherwise) | same |
| Frames | JSON, Zod-validated both ways, client frames ≤ 4 KiB (ADR-036): client `auth`, `typing`, `ping`; server `ready`, `ack`, `error`, `message`, `receipt`, `typing`, `conversation`, `reconnect` | Protobuf (ADR-020) |
| Sends | REST (ADR-036); the socket only pushes | socket submit + REST fallback |
| Fan-out | per-user Valkey channel (ADR-037) | per-device routes (§3) |
| Limits | 10 sockets/user (4429), 50k/pod (1013), 20 frames/s burst 40 (4408), typing 1 per 3 s per conversation, backpressure close at 1 MiB buffered (1013) | + per-device eviction, per-IP unauthenticated cap |
| Heartbeat | ping every 25 s, terminate on missed pong; presence refreshed in pipelined batches of 1,000 keys (Phase 15: one transaction per user stalled delivery) | same |
| Deploys | SIGTERM → `reconnect{afterMs: random 0..30 s}` → drain (`SHUTDOWN_DRAIN_MS` 30 s, shutdown timeout 45 s; was 5 s until Phase 15, which stalled sends during deploys — capacity.md §4); cleanups of closed sockets finish before Valkey closes | same |
| Presence | online flag (TTL 90 s) + last seen, visibility enforced at read time with reciprocity (hidden users see no one's) | same |
| Typing | server-visible `typing` frames, membership-checked, not persisted (metadata, documented) | MLS-encrypted typing |

Not yet implemented: per-IP cap on unauthenticated sockets (the auth timeout bounds their
lifetime; an edge limit is required before public launch — Phase 15/17), metrics listed in §9
(Phase 14/15 observability work; structured logs exist now).

## 1. Responsibilities

`services/realtime` terminates WSS connections and delivers: new-message notifications
(`msg.new`), receipts, presence, typing, call signalling wake-ups, and device-control
events (revocation, forced logout). It accepts: message submits, cursor acks, typing,
presence heartbeats. It is **stateless apart from open sockets**.

## 2. Connection establishment

```
Client                                    realtime pod                          Valkey / Postgres
 1. GET wss://rt.<domain>/v1/ws  (cookie __Host-tsid is NOT sent: different host)
    → so first: POST /api/v1/realtime/ticket (same-site API, cookie + CSRF header)
       ← {ticket: 256-bit random, ttl 30 s, bound to session+device+origin}
 2. new WebSocket("wss://rt.<domain>/v1/ws", ["tessera.v1"]) ; first frame: {type:"auth", ticket}
                                         3. validate Origin header ∈ allow-list  (CSWSH defence)
                                         4. GETDEL ticket → {session, device}   (single use)
                                         5. verify session active + device not revoked
                                         6. register route: HSET route:{device} node=<pod>,conn=<id>
                                            SUBSCRIBE node:<pod>
                                         7. send {type:"ready", heartbeat: 25}
```

Why a ticket instead of the cookie: keeps the WSS host separate from the API origin
(isolation, independent scaling) and gives single-use, short-lived, origin-bound
credentials; tickets never appear in URLs (not logged by proxies). Native clients use the
same ticket endpoint with their device token.

Auth frame must arrive within 5 s or the socket is closed (4401). Unauthenticated sockets
count against a per-IP limit.

## 3. Fan-out

Rejected design: publishing to a `conv:{conversation_id}` channel would require every node
to subscribe to every conversation its sockets belong to (subscription churn scales with
users × conversations). Chosen design — route by device:

1. Outbox relay resolves target devices for an event (conversation devices minus sender).
2. Looks up `route:{device}` for each (pipeline HMGET) → group by node.
3. `PUBLISH node:{pod} <batch>`; each pod delivers to its local sockets.
4. Devices with no route: nothing to do (they'll sync on reconnect) + notification job.

At large-group scale this is O(devices) lookups per message — bounded by the 1,024-member
E2EE cap. Channels use a different path (pull + CDN), see [channels.md](channels.md).

Routing entries have TTL 90 s refreshed by heartbeats; stale entries are harmless (message
still in mailbox).

## 4. Frame protocol (Protobuf, ADR-020)

```
ClientFrame  { id, oneof { Auth, Submit, CursorAck, Typing, PresencePing, SyncHello, CallSignalWake } }
ServerFrame  { id/in_reply_to, oneof { Ready, Ack, Error, MsgNew, Receipt, Presence, Typing,
                                        SyncRequired, DeviceRevoked, SessionRevoked, CallRing } }
```

- Max frame 70 KiB (64 KiB ciphertext + envelope); larger → close 1009.
- Every client frame validated against schema; unknown types → `Error{UNSUPPORTED}`.
- Every request frame gets exactly one `Ack` or `Error` correlated by `id`.

## 5. Heartbeat, reconnect, backoff

- Server sends WebSocket ping every 25 s; two missed pongs → close. Client-level
  `PresencePing` every 60 s while app is foregrounded.
- Client reconnect: exponential backoff with full jitter, 0.5 s → 30 s cap; reset after
  60 s stable. Immediately reconnect on `online` event / visibility regain.
- On reconnect: `SyncHello` with cursors → server replies with conversations needing sync.
- Deploys: pods receive SIGTERM → stop accepting, send `Reconnect{after_ms: random(0..30s)}`
  to spread reconnect storms, drain for up to 60 s.
- Valkey loss (F-15, Phase 17): fan-out runs over Valkey pub/sub, so events published while a
  pod's subscription is down are lost. When the subscription comes back the pod sends every
  authenticated connection `reconnect{afterMs: random(0..RESYNC_SPREAD_SECONDS)}` (15 s default,
  60 s in production); the clients' normal catch-up then fetches what they missed. Counted in
  `tessera_realtime_resyncs_total`.

## 6. Limits and abuse controls

| Control | Value |
|---|---|
| Connections per device | 1 (new connection evicts old with close 4409) |
| Connections per user | 10 |
| Unauthenticated connections per IP | 20 |
| Inbound frames per connection | 30/s burst, token bucket |
| Typing frames | 1 per 3 s per conversation |
| Backpressure | if `bufferedAmount` > 1 MiB for >10 s → close 1013 (client resyncs) |
| Per-pod max sockets | 50k (tuned by load test) |

## 7. Presence and typing

- Presence stored in Valkey: `presence:{user}` = last_active ts (TTL 120 s).
- Visibility governed by privacy settings (everyone / contacts / nobody) — enforced at
  **read** time when a subscriber requests presence; presence of users who hide it is never
  sent. "Contacts" = users with an existing direct conversation (server-known).
- Typing indicators are MLS-encrypted `Typing` payloads relayed via realtime without
  persistence (the server knows *that* a typing frame was sent — metadata, documented).

## 8. Security checklist

Origin allow-list; single-use tickets; TLS 1.2+ (1.3 preferred) at NLB/ALB; authorization
re-checked on every submit (membership may have changed since connect); session revocation
pushes `SessionRevoked` and closes within 1 s (revocation event fan-out by device route);
no plaintext content ever handled; logs contain frame type, size, latency — never payload.

## 9. Observability

Metrics: open connections (per pod, per client kind), connects/s, auth failures by
reason, frames in/out by type, fan-out latency (outbox commit → socket write), backpressure
closes, reconnect rate. Alert on connection drop >20% in 5 min.
