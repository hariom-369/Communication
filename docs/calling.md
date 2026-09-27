# Voice and video calling

Status: NEEDS-SECURITY-REVIEW (S-08) · Decisions: ADR-016, 017

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
