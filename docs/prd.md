# Product Requirements Document

Status: PROPOSED · Owner: Product + Architecture · Related: [feature-matrix.md](feature-matrix.md), [implementation-plan.md](implementation-plan.md)

## 1. Product statement

Tessera is a communication platform for people, groups, communities and creators that is
**private by default where it matters (1:1 and group chats are E2EE), open where the
user chooses (public channels and communities)**, and honest about the difference.

Positioning in one sentence: *Signal-grade privacy for conversations, Telegram-grade reach
for broadcasting, Discord-grade structure for communities — in one product with its own identity.*

## 2. Target users and personas

| Persona | Needs | Primary surfaces |
|---|---|---|
| **Private individual** (18+, India-first) | Talk to friends/family privately, on phone and laptop, without losing history | 1:1, groups, calls, backups |
| **Group organiser** (housing society, college alumni, sports club) | Manage 20–1,000 people, admins, invites, announcements, polls | Groups, communities |
| **Creator / publisher** | Reach 10k–1M+ subscribers, analytics, scheduled posts, monetisation later | Channels |
| **Small business** | Verified identity, customer conversations, catalogue later | Business accounts (Phase 13+) |
| **Moderator / trust & safety staff** | Queue, evidence, actions, appeals, audit | Admin app |
| **Security-conscious user** | Verify contacts, see linked devices, control metadata | Safety numbers, privacy center |

Minors: see §8 (constraint L-06). **Launch audience is 18+ until verifiable parental
consent is designed and approved.**

## 3. Goals

1. Private conversations whose content Tessera cannot read (E2EE; [e2ee.md](e2ee.md)).
2. Reliable delivery: no silent message loss; explicit delivery states.
3. First-class multi-device, including web and desktop, without a phone being the
   single source of truth ([multi-device.md](multi-device.md)).
4. Scale from 10k to 10M+ users without re-architecture ([scaling.md](scaling.md)).
5. Operate lawfully in India with documented, reviewed compliance ([compliance.md](compliance.md)).
6. Commercial viability: freemium with Premium / Business / Creator tiers ([billing.md](billing.md)).

## 4. Non-goals (explicit)

- Federation with other networks (Matrix/XMPP/RCS) — not in scope; protocol choice does
  not preclude it later.
- Server-side AI over private messages — prohibited ([ai.md](ai.md)).
- Anonymous accounts with zero identifiers — legal review may forbid; out of scope for v1.
- Crypto-currency payments.
- Custom cryptographic protocols — prohibited.

## 5. Functional requirements

Priority: **P0** = required for public beta; **P1** = required for GA; **P2** = post-GA.
Phase references are to [implementation-plan.md](implementation-plan.md).

### 5.1 Accounts, authentication, devices (Phase 2)
| ID | Requirement | Pri |
|---|---|---|
| AUTH-1 | Sign up with email (+ optional phone, subject to L-02/L-03) and unique username | P0 |
| AUTH-2 | Password (Argon2id) and passkeys (WebAuthn); passkey-only accounts allowed | P0 |
| AUTH-3 | TOTP 2FA; recovery codes; passkey counts as phishing-resistant 2FA | P0 |
| AUTH-4 | Email and phone verification; password reset; account recovery flow | P0 |
| AUTH-5 | Session list, per-session revoke, "log out all devices" | P0 |
| AUTH-6 | Suspicious-login detection and security alerts | P1 |
| DEV-1 | Each device has its own identity keys; linked-device list with revoke | P0 |
| DEV-2 | Link a new device by QR from an existing device, or via recovery key | P0 |

### 5.2 Messaging (Phases 3–5)
| ID | Requirement | Pri |
|---|---|---|
| MSG-1 | 1:1 and group E2EE text messages across all of a user's devices | P0 |
| MSG-2 | Delivery states SENDING→QUEUED→SENT→DELIVERED→READ, and FAILED | P0 |
| MSG-3 | Replies, mentions, reactions, edit (time-limited), delete-for-me / for-everyone | P0 |
| MSG-4 | Disappearing messages (per-conversation timer) | P0 |
| MSG-5 | Typing indicators, presence/last-seen honouring privacy settings | P0 |
| MSG-6 | Offline delivery with 30-day mailbox retention (ADR-010) | P0 |
| MSG-7 | Polls (E2EE in groups) | P1 |
| MSG-8 | Local (on-device) search of private messages | P1 |
| MSG-9 | Threads in groups/communities | P2 |

### 5.3 Security features (Phases 4–5)
| ID | Requirement | Pri |
|---|---|---|
| SEC-1 | Safety number + QR verification per contact | P0 |
| SEC-2 | Key-change and new-device warnings; verified/unverified state | P0 |
| SEC-3 | Encrypted backups with recovery key; passkey-assisted recovery where supported | P0 |
| SEC-4 | Device-to-device history transfer | P1 |
| SEC-5 | Key transparency (auditable directory) | P2 |

### 5.4 Media (Phase 6)
Images, video, audio, voice notes, documents/PDF/archives, contact cards, location — all
client-encrypted in E2EE conversations; resumable upload; size limits per tier. P0 except
location (P1).

### 5.5 Groups and communities (Phase 7)
Groups up to 1,024 members E2EE (ADR-011); roles, permissions, invite links, join
requests, bans, pinned messages, announcements-only mode, ownership transfer (P0).
Communities: container of groups/channels, roles, discovery, rules, member verification (P1).

### 5.6 Channels (Phase 8)
Public/private broadcast channels, usernames, subscriber counts, reactions, comments,
polls, scheduled posts, admin roles, analytics, reporting. **Channels are not E2EE** and
are labelled as such (ADR-012). P1.

### 5.7 Calls (Phase 9)
1:1 audio/video (P0 for GA), group calls via SFU up to 32 video / 100 audio initially (P1),
screen share, device switching, call history, missed calls, quality indicators. E2EE for
1:1 and group calls (ADR-016, ADR-017).

### 5.8 Notifications (Phase 10)
Web push without message content by default; email for account/security events; native
push architecture ready.

### 5.9 Trust & safety (Phase 11) and Admin (Phase 12)
Report user/message/group/channel; E2EE reporting only by explicit user action; block,
mute; spam/flood controls; restrictions, suspensions, bans, appeals; moderator queues;
evidence management; admin RBAC; full audit trail. **P0 — required before public beta.**

### 5.10 Billing (Phase 13)
Tiers FREE / PREMIUM / BUSINESS / CREATOR; entitlements decoupled from messaging. P1.

### 5.11 Privacy center
All controls listed in [privacy.md](privacy.md); data export; account deletion. **P0.**

## 6. Non-functional requirements

| Area | Target (public beta → GA) |
|---|---|
| Availability (messaging API + realtime) | 99.9% → 99.95% monthly |
| Message send→server ack | p95 < 250 ms, p99 < 600 ms (India users) |
| Server ack→online recipient device delivery | p95 < 500 ms |
| REST API latency | p95 < 200 ms, p99 < 800 ms (excluding uploads) |
| Durability of accepted messages (within retention window) | No loss after SENT ack (synchronous commit, Multi-AZ) |
| RPO / RTO (platform) | 5 min / 1 h (see [disaster-recovery.md](disaster-recovery.md)) |
| Accessibility | WCAG 2.2 AA |
| Security verification | OWASP ASVS 5.0 L2 overall; L3 for auth, session, crypto, admin |
| Browser support | Last 2 versions of Chrome, Edge, Firefox, Safari (desktop + mobile) |
| Privacy | No private content in logs, analytics or AI pipelines |

## 7. UX principles (Phase 1 design system; [architecture.md §9](architecture.md))

- Original visual identity: not WhatsApp green bubbles, not Discord's layout. Design system
  owned in `packages/ui` with tokens; dark + light; reduced motion; WCAG 2.2 AA.
- Desktop: rail (sections) → conversation list → conversation → details panel.
  Mobile: bottom nav → list → conversation → settings.
- Every async surface has loading (skeleton), empty, error, offline and reconnecting states.
- Security UI is plain-language: "Only you and Asha can read this chat" vs
  "This channel is public; Tessera stores posts on its servers".

## 8. Constraints and open product questions

| ID | Constraint / question | Owner |
|---|---|---|
| L-02/L-03 | Phone number as identifier may trigger SIM binding + MNV obligations → affects sign-up design | Legal |
| L-06 | Under-18 users require verifiable parental consent (DPDP) → launch 18+ | Legal + Product |
| L-04 | Traceability rule vs E2EE if we cross 50 lakh Indian users | Legal |
| P-01 | Brand, name, visual identity (codename only today) | Product/Design |
| P-02 | Launch geography: India-only beta vs global | Product + Legal |
| P-03 | Business accounts: API-based customer messaging requires separate threat model | Product + Security |

## 9. Launch gates

Public beta may not open until: Phases 0–7 and 10–12 exit criteria met; external
cryptographic review of Phases 4–5 complete (S-01..S-05); legal sign-off on L-01..L-09;
grievance officer and contact published; incident response runbook tested.
