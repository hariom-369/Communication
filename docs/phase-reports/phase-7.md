# Phase 7 report — Groups (7a) and communities (7b)

## Phase 7a — End-to-end encrypted groups

**Status: GREEN locally — NOT releasable to users.** Verified 2026-10-02 (commit c21e881). CI
has not run, because the branch still cannot be pushed (GitHub returns 403 for the Claude app).

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

## Phase 7b — Communities

**Status: GREEN locally — NOT releasable to users.** Verified 2026-10-02. Same CI caveat as 7a.

Communities group people and several spaces. A community's name, description, rules, roles and
member list are server-protected (readable by Tessera's servers, like a public profile). Each
space is an end-to-end encrypted group from 7a. Design and trade-offs: ADR-045 and
[groups.md](../groups.md) §5.

### Results (whole repository, end of Phase 7)

| Gate | Result |
|---|---|
| Format, lint, typecheck, build; `rustfmt`, `clippy -D warnings` | pass |
| Unit tests | **380 TypeScript** (api 198, web 95, ui 59, platform 15, shared 7, realtime 3, validation 3) + **71 Rust** |
| Integration (real PostgreSQL + Valkey + S3-compatible store) | **123**: api 108, realtime 15 |
| End-to-end (Chromium, production build, strict CSP + Trusted Types, real services) | **29 passed in each of the last 3 consecutive full runs** (2 new community tests; axe audit extended) |
| Accessibility (axe) | no violations on the new-group dialog, group details, communities directory and community page |
| Mutation checks (community server controls) | 6/6 caught: account-age gate, role-assignment hierarchy, permission-subset rule, space eligibility, removal on role loss, private-community visibility |
| OpenAPI | 103 paths (21 new) |
| `pnpm audit --prod` / gitleaks (history) | no known vulnerabilities / no leaks |

### Delivered

- **API (`modules/communities`, migration `0008_communities.sql`):** 28 routes.
  - Create, view, update, delete (step-up).
  - Public directory search.
  - Join a public community, gated by rules version, account age and bans.
  - Join a private community only through an invite link (digest-stored token, expiry, max uses).
  - Leave; member list (paged).
  - Roles: create, update, delete; assign to members within the hierarchy.
  - Kick, ban and unban; ownership transfer (step-up).
  - Spaces: create, list, delete, join; the caller's own spaces.
  - Moderation and role changes are written to the audit log.
  - A configurable per-address flood guard (`IP_FLOOD_LIMIT_PER_MINUTE`, default unchanged at 1,200).
- **Messaging integration:**
  - `SpaceGate` checks eligibility on every path into a space.
  - The server takes people out of spaces when they leave the community, are removed or lose a role.
  - When a space owner leaves, server-side ownership passes to an admin, whose device then commits
    the end-to-end takeover.
- **Web:**
  - Communities directory and creation.
  - Community page: rules acceptance, spaces, members and roles, invite links, bans, settings,
    leave and delete.
  - `/join/:token` invite page.
  - Conversation titles for spaces: "Community · Space".
  - Admin devices auto-approve requests in open spaces.
  - Adding or approving someone now waits until they are in the encryption group.
  - Rate-limited reads are retried once.

### Defects found and fixed during 7b

1. **Messages written right after approving someone were unreadable to them.** The add was still
   in flight, so the message was encrypted before they joined. Adding or approving now waits until
   the add has been applied, and the button shows progress.
2. **Intermittent E2E failures across unrelated tests** were caused by HTTP 429 from the per-address
   flood guard. Every simulated user comes from 127.0.0.1. The guard is now configurable and the
   E2E harness raises it. The client also makes fewer requests (space-label reloads are
   coalesced) and retries rate-limited reads once.
3. **Private communities leaked their existence** through 403 instead of 404 on delete and
   transfer. Fixed and tested.
4. **The space form lost input** while a previous space was still being set up, and **space lists
   did not refresh** after an admin's device added the member. Both fixed.

### Not met / deferred (tracked)

- Non-E2EE large rooms above 256 members: they will reuse Phase 8 channel storage. Community
  announcement broadcast rooms and moderator-group automation are also deferred.
- Open spaces trust the server's list of eligible members (stated in the UI; off by default).
  Removing that trust needs MLS external commits with client-checked eligibility (S-12).
- Community change notifications go to every member, which needs Phase 8 fan-out at large scale.
  There are no phone-verification gates, because phone numbers are not collected.

### Security implications (threat-model delta)

- **Mitigated:**
  - Role escalation: the server enforces the rank hierarchy and the permission-subset rule.
  - Discovery of private communities: non-members get 404 on every route.
  - Joining spaces without the required role: eligibility is checked on every path into a space.
  - Unaudited moderation: audit records are written inside the same transaction.
- **Residual:**
  - Community container data is server-readable by design.
  - A malicious server can admit people to auto-approve spaces.
  - Public community names and descriptions are searchable by every signed-in user.
