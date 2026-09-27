# End-to-end encryption architecture

Status: NEEDS-SECURITY-REVIEW · Decisions: ADR-004..011, 013, 014, 016, 017, 021
Protocol details: [crypto-design.md](crypto-design.md) · Devices: [multi-device.md](multi-device.md) ·
Backups: [encrypted-backups.md](encrypted-backups.md)

## 1. Scope — what is and is not E2EE

| Surface | Protection | Who can read content |
|---|---|---|
| 1:1 chats (text, media, reactions, edits, deletes, polls, receipts) | **E2EE** (MLS) | Member devices only |
| Groups ≤ 1,024 members | **E2EE** (MLS) | Member devices only |
| Group name, description, avatar | **E2EE** | Member devices only |
| 1:1 calls | **E2EE** (DTLS-SRTP, fingerprints authenticated via MLS) | Participants |
| Group calls | **E2EE** (SFrame over SFU, keys from MLS exporter) | Participants |
| Encrypted backups | **E2EE** (client-side, user-held key) | User |
| Community large rooms, broadcast channels, comments | **Server-protected** | Tessera (and anyone the channel is public to) |
| Profiles (name, photo, about) | Server-protected, privacy-filtered | Per privacy settings |
| Business/bot conversations | E2EE to the bot's device; **the bot operator can read** | Participants + operator (disclosed) |

## 2. Security goals

| Goal | Mechanism |
|---|---|
| Confidentiality of private content from server | MLS; server stores ciphertext only |
| Integrity + authenticity (sender device) | MLS signatures (Ed25519) + AEAD |
| Asynchronous session establishment | One-time KeyPackages (+ last-resort KeyPackage) published per device |
| Forward secrecy | MLS secret tree: per-message keys deleted after use; epoch secrets deleted after epoch change |
| Post-compromise security | Commits with path updates; scheduled self-updates (7 days / 100 msgs) |
| Multi-device | Each device is an MLS leaf; device certificates signed by the user's Account Signing Key |
| Device verification / key-change detection | Safety numbers from ASK; client pins ASK per contact; warnings on change |
| Replay / duplicate protection | MLS generation counters + reuse guard; server `seq` + client dedupe on message id |
| Server cannot add ghost devices | Clients accept only devices with a valid ASK-signed certificate (ADR-007) |
| Post-quantum confidentiality | Hybrid KEM ciphersuite at GA if approved (ADR-005) |

## 3. Non-goals and residual risks (stated plainly)

1. **Metadata is visible to the server** — who talks to whom, when, group membership,
   message sizes/timing, IP addresses, device counts. See the full inventory in
   [privacy.md §4](privacy.md). Sealed-sender-style protections are a research item (S-09).
2. **Endpoint compromise defeats E2EE.** Malware, malicious browser extensions, or a
   person with the unlocked device can read messages.
3. **Recipients can copy content.** Disappearing messages are a convenience, not DRM.
4. **Web client code is served by us** (see §7).
5. **Users who never verify safety numbers** rely on trust-on-first-use of the ASK; a
   compromised server could substitute an ASK *before* first contact. Key transparency
   (S-07) is the planned mitigation.
6. **Reported content is disclosed by the reporter**, by design (ADR-021).

## 4. Key hierarchy

```
User
 └─ Account Signing Key (ASK, Ed25519)          — on trusted devices + in encrypted backup
     ├─ DeviceCertificate(Device A)  ──signs──▶ Device A MLS signature key (Ed25519)
     │                                          ├─ KeyPackages (HPKE init keys, one-time + last-resort)
     │                                          └─ per-group leaf state (encryption keys, secret tree)
     ├─ DeviceCertificate(Device B)  …
     └─ DeviceCertificate(Device C)  …
Backup Root Key (BRK, 256-bit random)
 ├─ wrapped by Recovery Key (user-held)
 └─ wrapped by Passkey PRF output (optional)
Local Storage Key (per device, non-extractable WebCrypto AES-256-GCM) — encrypts IndexedDB state
```

## 5. Message flow (1:1, both users have two devices)

```
Alice-phone      Server (Delivery Service)                  Bob-web / Bob-laptop / Alice-laptop
    │ 1. GET /keys/users/{bob}/devices  → ASK + device certs (Bob-web, Bob-laptop), own devices
    │ 2. verify certs against pinned ASK(bob) (TOFU on first contact; warn on change)
    │ 3. POST /keys/claim {devices:[...]} → one KeyPackage per device (one-time, else last-resort)
    │ 4. create MLS group; Add(Bob-web, Bob-laptop, Alice-laptop); Commit
    │ 5. POST /conversations {commit (PublicMessage), welcome(s) per device}
    │                ├─ stores commit at seq=1, epoch 0→1
    │                └─ stores Welcome per device ──────────────▶ delivered on connect
    │ 6. encrypt "hi" (PrivateMessage, epoch 1) → POST /conversations/{id}/messages
    │                └─ seq=2 stored once, fanned out ─────────▶ each device decrypts
    │◀──────── 7. delivery ack per device (server-visible); read receipts sent as E2EE messages
```

## 6. Handshake visibility policy

MLS handshake messages (proposals/commits) are sent as **PublicMessage** (signed, not
encrypted) so the Delivery Service can: enforce ordering (ADR-009), enforce group
policy (only admins may add/remove when so configured), and maintain routing tables.
This reveals membership changes to the server, which it must know for routing anyway.
**Clients independently enforce the same policy** from the E2EE group context — the server
is not trusted to enforce it alone. Application messages are always **PrivateMessage**.

## 7. The web code-delivery problem

A browser downloads client code from our servers. A compromised or coerced server (or
CDN) could serve code that exfiltrates keys, which **no protocol can prevent**.

Mitigations:
1. Static, content-hashed bundles; strict CSP (`script-src 'self' 'wasm-unsafe-eval'`),
   Trusted Types, SRI on every script, no third-party scripts in the app origin.
2. Reproducible builds; each release's asset hashes published in a signed, append-only
   release manifest (Sigstore transparency log) so third parties can audit what was served.
3. Service Worker pins the app shell and refuses to activate a new version whose manifest
   signature fails to verify (defends against CDN tampering, **not** against a malicious
   signing key holder).
4. Separate origin for user-generated content (`*.usercontent` domain) — no user content is
   ever rendered as HTML in the app origin.
5. Higher-assurance desktop client (ADR-019) and future verification browser extension.
6. Product copy says the web app is E2EE but recommends the desktop/mobile app for
   high-risk users.

**Review item S-03.**

## 8. What the server stores per E2EE conversation

`mls_group_id`, current `epoch`, ciphersuite, member user IDs, member device IDs + leaf
indices, commits/proposals (PublicMessage, until acked/30 days), application ciphertext
(until acked/30 days), per-device ack cursors, disappearing-timer value (mirrored so the
server can delete early). It never stores epoch secrets, application keys, or plaintext.

## 9. Verification UX

- Contact info → "Verify": shows 60-digit safety number (12 groups of 5) + QR.
  Derivation in [crypto-design.md §8](crypto-design.md).
- Verified contacts show a check; ASK change → blocking interstitial on next send
  ("Asha's security key changed. This can happen if they reset their account…").
- New device of a contact → non-blocking notice in the conversation.
- Own linked devices page shows each device, when it was linked, by which device.

## 10. Assumptions

- A1: Browsers provide a CSPRNG (`crypto.getRandomValues`) and correct WebCrypto AES-GCM.
- A2: OpenMLS correctly implements RFC 9420 for the chosen ciphersuite (audit-backed; we
  pin versions and track advisories).
- A3: TLS 1.3 to our edge protects metadata from network observers (not from us).
- A4: Users can protect a 52-character recovery key or use a passkey.
