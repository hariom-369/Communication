# Privacy architecture and privacy center

Status: PROPOSED · Legal: L-06..L-09 · Related: [compliance.md](compliance.md)

## 1. Principles

Data minimisation; purpose limitation; E2EE for private content; privacy-protective defaults;
transparent metadata inventory; user control and deletion; no sale of personal data;
no advertising profiling at launch.

## 2. Privacy center — user controls

| Setting | Options | Default | Enforced where |
|---|---|---|---|
| Profile visibility (name, about) | everyone / contacts / nobody | everyone (name), contacts (about) | server |
| Profile photo | everyone / contacts / nobody | contacts | server (photo URL access check) |
| Last seen | everyone / contacts / nobody (reciprocal: hiding yours hides others') | contacts | server |
| Online status | same as last seen / nobody | same as last seen | server |
| Read receipts | on / off (reciprocal) | on | **client** (E2EE receipts) |
| Who can message me first | everyone / contacts of contacts* / nobody (requests inbox) | everyone → message requests | server |
| Who can call me | everyone / contacts / nobody | contacts | server |
| Who can add me to groups | everyone / contacts / nobody (invite instead) | contacts | server |
| Discoverable by username | yes/no | yes | server |
| Discoverable by phone | yes/no (if phone enabled) | no | server |
| Channel/community discovery of my memberships | hidden always | — | server |
| Relay calls (hide IP) | always / unless the safety number is verified / never | unless verified | client + TURN |
| Link previews (sender generates) | on/off | on | client |
| Blocked users | list | — | server |
| Linked devices | list, revoke | — | server + client |
| Sessions | list, revoke, log out all | — | server |
| Encrypted backup | enable, rotate key, delete backups | prompted | client + server |
| Notification content | no content / sender only / sender + preview** | no content | client |
| Analytics participation | product analytics opt-out | on (aggregate, no content) | client + server |
| AI features | per-feature opt-in | off | client |

\* "contacts of contacts" deferred (requires graph queries; privacy review).
\** Preview generated on-device from decrypted content; never sent by server.

"Contacts" means users with whom you have an accepted direct conversation (server-known).

## 3. Data subject rights (DPDP)

- **Export** (`/privacy/export`): async job assembles server-held data (profile, settings,
  sessions, devices metadata, group memberships, channels owned/subscribed, reports filed,
  billing records) as JSON + README into an encrypted zip; download link valid 7 days;
  re-auth required. E2EE message history export is **client-side** (from device).
- **Correction**: profile/settings self-service; support channel for other data.
- **Erasure / account deletion**: re-auth + confirmation → 30-day grace period (login
  cancels) → saga deletes: sessions, devices, keys, KeyPackages, mailbox rows, blobs,
  backups, memberships (groups receive Remove commits), channels (transfer or delete),
  profile; retains only legally required records (billing, audit, legal holds,
  moderation records for repeat-offender prevention — in minimised form).
- **Grievance** and **nomination** (DPDP s.14) channels in the privacy center.
- Consent records: notice version, timestamp, purposes; withdrawal as easy as giving.

## 4. Metadata inventory — what the server can and cannot see

| Data | Server sees? | Retention | Notes |
|---|---|---|---|
| Private message content, media, reactions, edits, polls, read receipts, group names/avatars | **No** | — | E2EE |
| That device X sent a message to conversation C at time T, ciphertext size | Yes | ≤30 days (mailbox) + aggregated metrics | padded sizes reduce leakage |
| Conversation membership (users + devices) | Yes | while active | needed for routing and policy |
| Delivery acknowledgements per device | Yes | while message retained | |
| Typing events (existence, not content) | Yes (transient) | not stored | |
| Presence / last seen | Yes | last value only | visibility per settings |
| IP addresses | Yes | 180 days in ICT logs (CERT-In), coarse prefix on sessions | |
| Contacts / address book | No (not uploaded) | — | ADR-031 |
| Call occurrence (conversation, initiator user and device, start/answer/end, end reason, peak participant count) | Yes | 90 days (`CALL_RECORD_RETENTION_DAYS`); live participant rows only during the call | media and signalling E2EE |
| Call media | No | — | |
| Attachment existence, ciphertext size, uploader, blob↔conversation link, upload/download times | Yes | Until the referencing message expires (≤ 30 days); unsent uploads 1 day | [media.md](media.md), ADR-043. File names, types, dimensions, durations, previews and keys are **inside** the encrypted message only |
| Group membership, roles (owner/admin/member), who added whom, the two settings "members can add" and "announcements only", invitations, join requests, bans | Yes | while the group exists (rows deleted with it) | needed to route and enforce the API; the authoritative roles are also end-to-end in the group (ADR-044) |
| Communities: name, description, rules (and which version each member accepted), visibility, roles and their permissions, members and their roles, bans, invite-link usage, space names and who is in each space | Yes | while the community exists (deleted with it; ban rows kept until lifted or the community is deleted) | needed to list, search and enforce communities (ADR-045); public communities are searchable by any signed-in user |
| Blocks (who blocked whom, when) | Yes | until unblocked or an account is deleted | enforced by the server on every path; never shown to the blocked person ([moderation.md](moderation.md)) |
| Message franking commitment and server tag per message | Yes | with the ciphertext (≤ 30 days) | an HMAC commitment that reveals nothing without the key inside the encrypted message (ADR-049) |
| Reports: reporter, target, category, details, time, verification result | Yes | 1 year after the case closes (legal hold: longer) | the reporter is never shown to the reported person |
| Reported messages and files | Only as reported: sealed to the moderation key, opened for verification and for recorded moderator views | 1 year after the case closes (legal hold: longer) | only what the reporter selected ([moderation.md](moderation.md) §3) |
| Moderation cases, actions, notices, appeals, grievances (with the complainant's email), legal orders | Yes | case lifetime + 1 year; audit log entries per audit policy | needed for due process and legal duties |
| Link checks in chats | Only a 4-byte hash prefix shared by many hosts, when one matches | not stored | the link itself never leaves the device |
| Admin console views of an account (who looked, when, for which ticket, case or investigation reason) | Yes | per audit policy (hash-chained audit log) | purpose-bound and audited (ADR-050); the person's data shown is metadata only — never message content, password hashes, tokens or recovery codes |
| Support tickets (help-desk reference, the person, what they asked for) | Yes | while open + per audit policy | the purpose under which support staff may look at an account |
| Feature-flag rollout bucket | Derived (SHA-256 of flag and account id), not stored | — | the same person always gets the same answer for a staged rollout |
| Staff identities (admins: work email, name, identity-provider subject, security-key public keys, sessions with full client address) | Yes | while employed + audit policy | staff, not users; full addresses for accountability of privileged access |
| Plan and subscription (tier, provider, provider reference, status, period) | Yes | while the account exists; ended subscriptions kept with the invoices | card and UPI details stay with the payment provider (never sent to Tessera) |
| Billing details (name for invoices, country, Indian state, optional GSTIN) | Yes | while the account exists; snapshotted on each invoice | needed for GST place of supply ([billing.md](billing.md)) |
| Tax invoices (number, amounts, GST split, buyer and seller details) | Yes | as tax law requires (typically 8 years — L-11) | issued per payment |
| Payment webhook events (provider, event id, type, time) | Yes | with the subscription | idempotency only; no payload stored |
