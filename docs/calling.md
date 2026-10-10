# Voice and video calling

Status: IMPLEMENTED in Phase 9 ([report](phase-reports/phase-9.md)), NEEDS-SECURITY-REVIEW (S-08) ·
Decisions: ADR-016, 017, **047** (implementation, keying and deviations)

## 0. As built (Phase 9)

- **1:1 calls** are peer to peer (or through the TURN relay). Offers, answers and ICE restarts are
  `call` messages inside the conversation's MLS messages; each description carries all candidates.
  After DTLS completes, the client checks the presented certificate against the fingerprint
  received over MLS and ends the call on mismatch (`apps/web/src/calls/peer-call.ts`, `sdp.ts`).
- **Group calls** go through LiveKit. Media frames are SFrame-encrypted (RFC 9605) on the sending
  device with per-sender keys from the MLS exporter, exactly as RFC 9605 §5.2 describes, except
  that the exporter context is the call ID (ADR-047). Audio is encrypted whole; VP8 keeps its
  payload header in the clear for the SFU, authenticated as SFrame metadata.
- **Relay policy** (`callRelay` privacy setting): always / unless the person's safety number is
  verified (default) / never; enforced by each device for itself.
- **Server**: `services/api/src/modules/calls` — call records, `who can call me` enforcement,
  coturn shared-secret credentials (10 min), LiveKit join tokens (5 min, one room, publish and
  subscribe only, no data channel), ringing/ended realtime hints, a singleton sweeper (unanswered
  ringing after 45 s, silent or removed participants, 90-day record retention).
- **Features**: mute, camera on/off, screen share (1:1: replaces the camera picture without
  renegotiation; group: separate track, same encryption), microphone/camera switching without
  renegotiation, incoming-call dialog with ring tone, group-call invitations, call history in
  the chat, connection quality from `getStats()` (good/fair/poor, relayed/direct), ICE restart
  with fresh relay credentials after a network change, busy handling, glare (calling someone who
  is calling you answers their call).

Deviations from the original design below are listed in ADR-047. Incoming calls reach closed
tabs as content-free pushes since Phase 10 (ADR-048). Not done yet: host controls beyond removal
(mute requests), simulcast/SVC
tuning, SFU session resumption, call quality telemetry (no telemetry is collected).

## 1. Components

| Component | Choice | Role |
|---|---|---|
| Media stack | Browser WebRTC | Capture, codecs (Opus, VP8/VP9/AV1/H.264), DTLS-SRTP |
| STUN/TURN | coturn (self-hosted, UDP 3478, TCP/TLS 443 fallback) | NAT traversal; relay for privacy |
| SFU | LiveKit (self-hosted, Apache-2.0) | Group calls: selective forwarding, simulcast, congestion control |
| Signalling | E2EE MLS messages (`CallSignal`) + realtime "ring" wake-ups | Offer/answer/ICE; server can't MITM |
| Control plane | `services/calling` | Call records, TURN credentials, LiveKit tokens |

No custom media transport. No custom codecs.

## 2. 1:1 calls

```
Caller device                 Server                           Callee devices (all)
 1. POST /calls {conversation_id, kind} → call_id, TURN creds (TTL 10 min, coturn shared-secret "TURN REST API" scheme)
 2. CallSignal{offer SDP incl. DTLS fingerprint} sent as MLS message in the 1:1 conversation
                               3. realtime CallRing to online devices; web push "incoming call" (no caller content if privacy-set)
                                                                4. callee decrypts offer; verifies it came from
                                                                   caller's verified device (MLS sender)
 5. ◀─────────── CallSignal{answer SDP + fingerprint} (MLS) ────────
 6. ICE (P2P or TURN relay) → DTLS handshake: each side checks remote fingerprint == fingerprint
    received over MLS → SRTP keys derived from DTLS; media flows
 7. First device to answer wins; others receive CallSignal{answered_elsewhere}
```

- The DTLS fingerprint check is the security-critical step: because SDP travels inside
  MLS, a malicious server cannot substitute its own fingerprint.
- Privacy setting "Relay calls through Tessera" forces `iceTransportPolicy: "relay"`
  (hides IP from peer; TURN sees IP but not media plaintext). Default: relay for calls
  from non-contacts; direct allowed for contacts.
- Call history: stored locally (E2EE); server stores a minimal call record
  `(call_id, conversation_id, initiator_device, started_at, ended_at, participant count)`
  for billing/abuse/ops — documented metadata.

## 3. Group calls (SFU)

```
Participants ──(DTLS-SRTP hop encryption)──▶ LiveKit SFU ──▶ Participants
     └── frame payloads additionally E2EE (SFrame, RFC 9605) via RTCRtpScriptTransform
         key = HKDF(MLS-Exporter("tessera call", call_id, 32), "sframe" || epoch)
```

- Joining requires: membership in the conversation (server check) + a LiveKit JWT (TTL 5 min,
  room = call_id, identity = device_id, grants limited to publish/subscribe).
- Media keys derived from the conversation's MLS exporter secret, so only current group
  members can decrypt. On join/leave: an MLS commit changes the epoch → new call key;
  participants switch keys with a short overlap window (key ID in SFrame header).
- SFU sees: participant identities (device IDs), who is speaking (audio level header
  extension — **disabled or E2EE-protected where possible; review S-08**), bitrates,
  timing, IPs. It does not see decrypted media.
- Browsers without Encoded Transform support: E2EE group calls are refused with an
  explanation. No silent downgrade.
- Limits at launch: 32 video / 100 audio participants; simulcast 3 layers; SVC (VP9/AV1)
  where supported.

## 4. Features

Mute, camera toggle, screen share (separate track, same E2EE), device switching
(`enumerateDevices` + `replaceTrack` without renegotiation), ringing, missed calls
(local E2EE record + push), reconnect (ICE restart on network change; SFU session
resumption within 30 s), connection quality from `getStats()` (RTT, jitter, packet loss,
available bitrate) shown as 3-level indicator; host controls for group calls (mute
participant = request; remove participant = conversation-admin action + re-key).

## 5. Capacity and deployment

- TURN and SFU on dedicated node groups with host networking and public IPs; UDP port
  ranges opened narrowly; separate autoscaling by participant count.
- TURN credentials never long-lived; TURN servers deny relaying to private/internal IP
  ranges (`denied-peer-ip` for RFC1918, link-local, metadata IPs) — prevents TURN SSRF
  into our VPC.
- Region: Mumbai + Hyderabad; later edge SFUs closer to users with cascading.

## 6. Metrics

Call setup time, setup failure rate by reason (ICE fail, permission denied, timeout),
relay ratio, MOS estimate from getStats (client-reported, aggregated, no content), SFU
CPU/bandwidth per room, TURN bandwidth. **Call quality telemetry is opt-out and contains
no audio/video content.**

## 7. Tests (Phase 9 exit)

Fingerprint-substitution attack by malicious signalling server fixture (call must fail);
re-key on membership change; unsupported-browser refusal; TURN deny-list; network
switch reconnect; 32-participant load test; screen share E2EE verified by SFU-side frame
inspection (frames must be ciphertext).

Where each lives (results in the [Phase 9 report](phase-reports/phase-9.md)):

| Exit test | Test |
|---|---|
| Fingerprint substitution by a malicious server | `e2e/calls.spec.ts` — the server delivers another conversation's genuine encrypted offer (attacker's fingerprint) in place of the real one: no ring, no answer, undecryptable placeholder. Unit: `sdp.test.ts` (substituted certificate fails). |
| Re-key on membership change | `e2e/calls.spec.ts` (epoch shown, frames switch epoch, removed member dropped); `call_tests.rs`; `frame-crypto.test.ts` |
| Unsupported-browser refusal | `e2e/calls.spec.ts` (no encoded-frame API → refused on start and join; nothing created on the server) |
| TURN deny-list | `services/api/src/modules/calls/turn-relay.integration.test.ts` against real coturn |
| Network-switch reconnect | `e2e/calls.spec.ts` (relay replaced mid-call → ICE restart with fresh credentials) |
| SFU-side frame inspection | `e2e/calls.spec.ts` (an SFU-admitted client without keys sees only SFrame ciphertext, correct epoch, no nonce reuse; an unencrypted participant is not played) |
| 32-participant load | see the Phase 9 report |

## 8. Running locally

- **coturn**: `apt install coturn` (or your package manager), then
  `turnserver -c infra/calls/turnserver.conf --static-auth-secret="$TURN_SHARED_SECRET"
  --listening-ip=127.0.0.1 --relay-ip=127.0.0.1 --allow-loopback-peers --allowed-peer-ip=127.0.0.1`.
  The last two flags are for local testing only (both browsers are on 127.0.0.1); never in a
  deployment.
- **LiveKit**: build `github.com/livekit/livekit-server` (v1.13.9, as CI does) or install a
  release, then `LIVEKIT_KEYS="tessera-dev: $LIVEKIT_API_SECRET" livekit-server --config
  infra/calls/livekit.dev.yaml`. The web dev server proxies `/sfu` to it (`TESSERA_SFU_URL`).
- API settings: `services/api/.env.example` (`TURN_*`, `LIVEKIT_*`). Without them, calls still
  work directly between peers (no relay), and group calls are unavailable (the buttons explain).
