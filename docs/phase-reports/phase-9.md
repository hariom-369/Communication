# Phase 9 report — Voice and video calls

**Status: GREEN locally, one exit criterion not met on this hardware** (the 32-participant load
test; see below). Verified 2026-10-09. CI has not run, because the branch still cannot be pushed
(GitHub returns 403 for the Claude app).

1:1 calls are peer to peer, with signalling inside the conversation's MLS messages and the DTLS
certificate checked against the fingerprint received over MLS. Group calls go through a
self-hosted LiveKit SFU with every frame SFrame-encrypted (RFC 9605) on the sending device,
keyed from the MLS exporter. Design, keying and deviations: ADR-016, ADR-017, **ADR-047** and
[calling.md](../calling.md) §0. Security review item **S-08** covers the group-call keying.

## Results

| Gate | Result |
|---|---|
| Format, lint, typecheck, build, Rust fmt/clippy | pass |
| Unit tests | **513 TypeScript** (api 307, web 119, ui 59, platform 15, shared 7, realtime 3, validation 3) + **75 Rust** |
| Integration (real PostgreSQL + Valkey + S3-compatible store + **real coturn**) | **139 passed** (api 124, realtime 15); 2 skipped: the IPv6 TURN deny-list test (this container has no IPv6; CI runs it) and the opt-in channel scale test |
| End-to-end (Chromium, production build, strict CSP + Trusted Types, real API, coturn and LiveKit) | **37 passed in each of 3 consecutive full runs** (6 new call tests; 1 skipped: the opt-in load test); the groups suite also passed 8 repeats after the fix to defect 8 |
| SFrame conformance | all RFC 9605 test vectors: 289 header encodings, cipher suites 4 and 5 (AES-128-GCM with 64- and 128-bit tags); RFC 5869 HKDF-Expand vector |
| 32-participant group call (`calls-load.spec.ts`, opt-in) | **Not met on this container** — see "Not met" |
| Accessibility (axe) | no violations; the phone-width check found a real overflow (fixed, below) |
| OpenAPI | 135 paths (8 new) |
| `pnpm audit --prod` / gitleaks (history and changed sources) | no known vulnerabilities / no leaks (the public RFC 9605 test vectors are allow-listed by path) |

### Exit tests (calling.md §7)

| Exit test | Where | Result |
|---|---|---|
| Fingerprint substitution by a malicious server | `e2e/calls.spec.ts`: the server swaps in another conversation's genuine encrypted offer carrying the attacker's fingerprint | no ring, no answer recorded, undecryptable placeholder; unit test: a substituted certificate fails |
| Re-key on membership change | `e2e/calls.spec.ts`, `call_tests.rs`, `frame-crypto.test.ts` | removing a member moves every device to the next key epoch; later frames carry the new epoch; the removed member is dropped from the call and cannot derive the new keys |
| Unsupported-browser refusal | `e2e/calls.spec.ts` | without an encoded-frame API, starting and joining are refused with an explanation; nothing is created on the server |
| TURN deny-list | `turn-relay.integration.test.ts` against real coturn | private, loopback, link-local/metadata, CGNAT, documentation, multicast and mapped ranges refused; a public address allowed |
| Network-switch reconnect | `e2e/calls.spec.ts` (relay killed and replaced mid-call) | ICE restart with fresh relay credentials; call reconnects |
| Screen share E2EE by SFU-side inspection | `e2e/calls.spec.ts` (a client admitted to the SFU without keys) | every frame it receives, screen share included, is SFrame ciphertext with a valid header and the current epoch; no nonce reuse; its own unencrypted microphone is never played by others ("waiting for keys") |
| 32-participant load | `e2e/calls-load.spec.ts` | 6 and 16: pass. 32: not met on this container (28 joined) |

### Load measurements (one 4-vCPU container running every browser, the API, LiveKit and coturn)

- **6 participants:** pass.
- **16 participants** (everyone sending audio and video): all joined in 10.4 s; each sampled device
  was decrypting all 15 others within 1.2 s.
- **32 participants** (meeting model: 4 speakers with cameras, 28 muted listeners, 4 browser
  processes): the group of 32 was created in 76 s and 28 participants were in the call when the
  test timed out. The container's load average reached 128 on 4 vCPUs: every participant
  encodes, encrypts, decrypts and decodes in the same machine. This measures the test host, not
  the design, but it is reported as **not met**. The test is ready to run on per-participant
  hardware (Phase 15 load environment).

## Delivered

- **Crypto core:** `call_secret` — the MLS exporter (`"SFrame 1.0 Base Key"`, context = call ID)
  with the device's leaf index and the member list, through WASM and the crypto worker. Rust tests
  cover shared secrets, per-call keys, re-key on removal and outsiders.
- **1:1 calls** (`apps/web/src/calls/peer-call.ts`, `manager.ts`):
  - Offer, answer, ICE restart and end as encrypted `call` messages; complete descriptions (no
    trickle); answers accepted only from the device the offer went to.
  - DTLS certificate check after the DTLS transport connects; fail closed on mismatch, missing
    certificate or timeout; fingerprint changes on renegotiation refused.
  - Relay policy (`always` / `unverified` (default) / `never`) on the Privacy page.
  - Incoming-call dialog with ring tone, decline, busy, missed, glare, 45 s ring timeout.
  - Mute, camera, screen share, microphone and camera switching without renegotiation.
  - Connection quality from `getStats()` (good/fair/poor, relayed/direct); ICE restart with fresh
    relay credentials when the connection fails.
- **Group calls** (`group-call.ts`, `sframe.ts`, `frame-crypto.ts`, `media-worker.ts`):
  - SFrame (RFC 9605) with per-sender keys per RFC 9605 §5.2; one counter per device; 3-epoch
    receive window; VP8 payload header authenticated in the clear; audio encrypted whole.
  - Plugged into the SFU client as its end-to-end encryption manager, so the browser holds frames
    until encryption is attached (no plaintext window).
  - Join from the conversation header or an invitation banner; participant grid with per-tile
    "decrypting" / "waiting for keys"; key epoch shown; screen share; re-key on commits.
- **API** (`modules/calls`, migration `0010_calls.sql`, 8 routes): capabilities, ICE servers
  (coturn shared-secret credentials, 10 min), start (with glare handling), join (participant
  limits: 2 peer to peer, 100 via the SFU), leave, heartbeat, record lookup and active group call;
  LiveKit join tokens (5 min, one room, no data channel); "who can call me" enforced; realtime
  ringing/active/ended hints; a singleton sweeper (unanswered ringing, silent or removed
  participants removed from the SFU, 90-day record retention).
- **Call history** in the chat, built on each device from the encrypted call messages.
- **Infrastructure:** coturn baseline config with deny-list (`infra/calls/turnserver.conf`),
  LiveKit dev config, CI jobs install coturn and build LiveKit v1.13.9.

## Defects found and fixed during the phase

1. **Groups larger than about 20 could not be created.** Adding members claims one KeyPackage per
   device, and the claim rate limit (50/h, burst 20) stopped the add part-way. Raised to 300/h,
   burst 100, with a regression test that adds 40 members at once (mutation-checked).
2. **Fingerprint verification raced the DTLS handshake.** The connection reported "connected"
   before the DTLS transport had a remote certificate. Verification now waits for the DTLS
   transport itself.
3. **ICE-restart offers had no candidates.** Gathering still read "complete" from the previous
   round; the end-of-candidates wait is now armed before the new description is applied.
4. **Group-call receivers decoded nothing.** The SFU client clears receiver transforms for rooms
   it believes are unencrypted, and Chromium ignores a receiver transform set later. Fixed by
   plugging SFrame in as the client's encryption manager (insertable streams).
5. **Declining raced the server's "ended" hint**, so the caller sometimes saw "Call ended" instead
   of "Call declined". The caller now reads the end reason from the call record.
6. **Muted participants were labelled "waiting for keys"** although they were sending nothing.
7. **The conversation header overflowed at phone width** (462 px of content in a 360 px viewport)
   after the call buttons were added; found by the accessibility E2E test. The header now wraps.
8. **A message sent while incoming messages were being decrypted could vanish from the sender's
   own timeline** (pre-existing since Phase 3, exposed by the full E2E runs: a new group
   sometimes showed no name, and once the creator's own message was missing). The incoming path
   copied the timeline before decrypting and wrote the copy back afterwards, overwriting the
   outbox's update. Incoming messages are now applied to the current timeline; a unit test
   reproduces the interleaving and fails without the fix. The message itself was always sent and
   stored; only the sender's view lost it until reload.
9. The callee answered receive-only (new transceivers instead of the offer's); glare check order.

## Not met / deferred (tracked)

- **32-participant load test:** 28 of 32 joined on this single 4-vCPU container before CPU
  saturation; to be re-run on per-participant hardware (Phase 15). 16 participants pass.
- **Incoming-call push** to closed tabs and other devices' notifications: Phase 10 (web push).
  Today a call rings on devices with the app open.
- **IPv6 TURN deny-list test** is skipped here (no IPv6 in this container); it is written and runs
  in CI.
- SFU session resumption, host controls beyond removal (mute requests), simulcast/SVC tuning.
- **No call-quality telemetry** is collected; only the server's call record exists.
- The SFU still sees the audio-level header extension (who is speaking, roughly how loud) — listed
  for S-08.

## Security implications (threat-model delta)

- **Mitigated:**
  - A malicious or compromised server substituting session descriptions or DTLS fingerprints
    (signalling is end-to-end encrypted and authenticated by MLS; the presented certificate is
    checked; E2E-tested with a real substitution).
  - The SFU or anyone admitted to it reading group-call media (SFrame with MLS-derived keys;
    frame inspection E2E test); removed members following a call after removal (re-key; dropped
    by the server).
  - Plaintext frames leaking before encryption is attached, and downgrade on browsers without
    frame-encryption APIs (refused).
  - The TURN relay being used to reach internal networks or cloud metadata (deny-list tested
    against real coturn); IP address exposure to unverified callers (relay by default).
  - Unwanted calls ("who can call me" enforced by the server); ringing floods (rate limits).
- **Residual:**
  - The server learns call metadata: who called which conversation, when, how long, how many
    took part (90-day retention, documented in privacy.md).
  - The SFU sees participant IP addresses, timing, frame sizes, VP8 frame headers and audio
    levels. Relayed 1:1 calls expose both addresses to the TURN server.
  - Group-call keying awaits external review (S-08).
