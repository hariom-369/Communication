# Phase 7 report — Groups (7a) and communities (7b)

## Phase 7a — End-to-end encrypted groups

**Status: GREEN locally — NOT releasable to users.** Verified 2026-10-02. CI has not run, because
the branch still cannot be pushed (GitHub returns 403 for the Claude app). 7b (communities) has
not started.

Like Phases 4–6, this needs the external cryptography review before real users rely on it:
S-12 (group policy in the MLS group context, client-side commit authorisation, intent-gated
adds). The design is in ADR-044 and [groups.md](../groups.md) §0.

People can now create end-to-end encrypted groups of up to 256 members, with owners, admins,
invitations, invite links that lead to admin-approved join requests, bans, ownership transfer,
announcement-only mode, encrypted group names and descriptions, pins, polls and mentions. The
server routes and enforces its own API. It never sees a group's name or content, and it cannot
add a reader or change roles.

### Results

| Gate | Result |
|---|---|
| Format, lint, typecheck, build (Rust → WASM → web); `rustfmt`, `clippy -D warnings`; fuzz crate builds | pass |
| Unit tests | **346 TypeScript** (api 169, web 90, ui 59, platform 15, shared 7, realtime 3, validation 3) + **71 Rust** (1 ignored: the large-group timing benchmark) |
| Integration (real PostgreSQL + Valkey + S3-compatible store) | **119**: api 104, realtime 15 |
| End-to-end (Chromium, production build, strict CSP + Trusted Types, real services) | **27 passed in each of 3 consecutive full runs** (3 new group tests) |
| Mutation checks | Rust receiver-side authorisation removed → 4 group tests fail; server group rules 7/7 caught; web intent gate and unlisted-member removal each caught |
| OpenAPI | 82 paths (20 new) |
| `pnpm audit --prod` / gitleaks (history; working tree outside dependencies) | no known vulnerabilities / no leaks |

### Delivered

- **Crypto core:** `group_policy.rs` (canonical `GroupPolicy`, permission rules); policy carried
  as GroupContext extension `0xF0A2` with RequiredCapabilities; every staged commit is authorised
  against the previous policy before merging; `groupPolicy`/`updatePolicy` exposed to WASM;
  handshake limits raised to 1 MiB.
- **API:** migration `0007_groups.sql`; `GroupsService` and 23 routes (create, add, remove, ban,
  unban, leave, roles, ownership transfer and delete with step-up, settings, invitations,
  invite links, previews, join requests); privacy setting "group invitations" honoured;
  announcement-only sends refused for members; Welcomes stored once per commit; the key directory
  is open to anyone sharing an active conversation (needed for group members).
- **Web:** worker and engine expose the policy and tag every decrypted record with the sender's
  authority; `group-intents.ts`; owner-only creation; intent-gated adds and removal of unlisted
  members; lost-epoch commits retried with backoff; overlapping preparation runs coalesced; group
  UI (new-group dialog, details and administration panel, invitations, `/invite/:token`, pinned
  bar, polls, mentions, read-only composer).

### Defects found and fixed during the phase

1. **Group members could not read each other's keys.** The key directory only allowed direct
   contacts, so members who had never chatted 1:1 failed to verify each other and could not join.
   Fixed (`sharesConversation`), with an integration test.
2. **A commit that lost an epoch race was never retried**, and a membership change arriving while
   a preparation run was in progress was dropped. Fixed (backoff retry, coalesced re-run), with
   unit tests.
3. **The message action bar could open under the chat list or header** once it gained Pin.
   It now opens inline under the message.
4. **The commit route rejected large group commits (413)** and the invite-link list showed used-up
   links. Both fixed.

### Not met / deferred (tracked)

- **1,024-member E2EE groups: not met.** Joining a 1,024-member group takes 5.6 s natively (the
  browser is slower), so the cap is 256 (1.3 s). This needs profiling before it can be raised
  (ADR-044).
- Auto-join links and open community spaces (MLS external commits) → S-12 / 7b.
- Automatic ownership reassignment when the owner deletes their account; group avatars; threads.
- A batch key-directory endpoint. Large groups do one lookup per member, eight at a time.
- Low-end Android Chrome timing profile: not run (no device lab here).

### Security implications (threat-model delta)

- **Mitigated:**
  - A malicious server listing an extra member ("ghost member"). The E2E test inserts one
    straight into the database: no device adds her, she receives no Welcome, and admins see her
    as "not confirmed".
  - A server forging roles or settings. Clients act only on the MLS copy, and a forged commit is
    rejected by every client (Rust tests).
- **Residual:**
  - The server sees membership, roles, invitations, join requests and invite-link usage.
  - It can delay or withhold members, or unlist someone; any member then completes the removal.
  - An optional preview title on an invite link is readable by the server.
  - Key-directory access now extends to group co-members.
  - Within 30 days, a membership intent could be reused by the server to re-list someone who
    left on their own. A removal through the UI sends a `remove` intent, which closes this case.
