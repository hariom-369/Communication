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
| Group name, description, pins, polls, votes, mentions | **No** | — | E2EE content |
| Invite links: token digest, expiry, use count, optional preview title | Yes | until revoked/expired and the group is deleted | the preview title is the only group text the server can read, and only if an admin sets one |
| Channels: handle, title, description, visibility, posts, polls and votes, reactions, comments, admins, subscribers, invite-link usage | Yes — **not end-to-end encrypted** (labelled in the UI) | until deleted by the author/admin or the channel is deleted | ADR-012/046; public channels and their posts are visible to any signed-in user |
| Channel views | Aggregate only: unique viewers per post per day (HyperLogLog), never who viewed | daily keys 40 days; daily totals while the post exists | owners see totals, never individuals |
| Link previews in channel posts | The URL and the page's title/description/site name, fetched by the server | with the post; fetch cache 1 h | fetched by the SSRF-hardened fetcher, no images |
| Push notification content | No (content-free push: conversation, channel or call id only, padded, encrypted to the browser) | — | [notifications.md](notifications.md), ADR-048; what a notification shows is decided and decrypted on the device |
| Push subscriptions (push service endpoint and keys, session, device), delivery successes/failures | Yes | until the session or device ends (then deleted by the hourly sweep) | the push service (Google, Mozilla, Apple, Microsoft) sees that and when a device is woken, never why |
| Notification preferences, quiet hours (incl. time zone), muted conversations | Yes | while set; expired mutes deleted | needed to decide whether to wake a device |
| Account security alerts (headline and details such as device type, network prefix, time) | Yes | 180 days (`SECURITY_ALERT_RETENTION_DAYS`) | shown in the app on every device; also emailed |
| Channel posts, comments, public profiles | Yes | until deleted | not E2EE |
| Search queries (public directory) | Yes | 30 days, not linked to profile for analytics | |
| Reported content | Yes — only what the reporter submits | case retention | ADR-021 |
| Device platform/UA family, app version | Yes | while device active | |
| Payment details | Tokens only (provider holds card/UPI data) | per tax law | |

This table is published (user-facing version) in the privacy policy.

## 5. Analytics privacy

Event schema allow-list (no free text, no content, no recipient IDs); user ID replaced by a
rotating pseudonymous ID for product analytics; aggregation thresholds (k ≥ 20) for
dashboards; self-hosted analytics pipeline (no third-party trackers in the app origin).

## 6. Children

Launch is 18+ (L-06). Age declaration at sign-up; accounts reported/identified as minors are
restricted pending the verifiable parental consent design required by DPDP.
