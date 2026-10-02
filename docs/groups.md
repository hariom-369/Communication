# Groups and communities

Status: Phase 7a IMPLEMENTED (E2EE groups) · communities §5 pending (7b) · Decisions: ADR-008,
009, 011, 012, **044** · Crypto: [crypto-design.md](crypto-design.md) · Review: S-12

## 0. What is implemented (Phase 7a)

| Area | Where | Notes |
|---|---|---|
| Roles/settings in the MLS group context (`0xF0A2`), checked on every commit by every client | `crypto-core/src/group_policy.rs`, `client.rs` | ADR-044; permission matrix §2 below |
| Server API: create, add, remove, ban/unban, leave, roles, ownership transfer (step-up), settings, delete (step-up), invitations, invite links, join requests | `services/api/src/modules/messaging/groups.ts`, `group-routes.ts`, migration `0007_groups.sql` | 256-member cap; privacy setting "group invitations" |
| Intent-gated adds (no member the server makes up is ever added) | `apps/web/src/messaging/group-intents.ts`, `e2ee.ts` | §3 |
| Encrypted name/description, pins, polls, votes, mentions, admin moderation deletes, announcement-only mode | `content.ts`, `timeline.ts`, `GroupPanel.tsx` | Rules enforced client-side from the sender's authenticated authority |
| UI: new group, group details, invitations, `/invite/:token` page, pinned bar, polls | `apps/web/src/pages/chats/*`, `pages/InvitePage.tsx` | |

**Differences from the original design below.** Group size is capped at 256, not 1,024 (measured,
ADR-044). Members cannot create invite links or pin (admins only). Links always lead to an
admin-approved request; there is no auto-join yet (S-12). Threads and group avatars are not
implemented. If the owner deletes their account, ownership is not yet reassigned automatically;
an admin can take over through the encryption policy, and the server mirror is fixed by "Finish
saving".


## 1. Group encryption design (evaluated separately from 1:1)

| Design | FS | PCS | Cost of membership change | Cost per message | Verdict |
|---|---|---|---|---|---|
| Pairwise fan-out (each message encrypted per device) | Strong | Strong | None | O(devices) encryptions + bandwidth | Fine ≤ ~50 devices; poor beyond |
| Sender Keys (Signal/WhatsApp groups) | Hash-ratchet FS | Only on re-key; removal requires every sender to re-distribute keys pairwise, O(n²) worst case | O(n) pairwise messages per sender | O(1) | Mature, but weak PCS |
| Megolm (Matrix) | Partial | Weak | Session rotation | O(1) | Known historical-key exposure properties |
| **MLS TreeKEM** | Strong | Strong (via commits) | O(log n) typical | O(1) | **Chosen** |

1:1 and groups use the same MLS mechanism (ADR-008), but group-specific policy lives in
the `groups` module: roles, permissions, invites, bans, and server-side enforcement of who
may commit Add/Remove.

## 2. Roles and permissions

| Permission | Owner | Admin | Member |
|---|---|---|---|
| Send messages | ✓ | ✓ | ✓ (unless announcements-only) |
| Add members | ✓ | ✓ | configurable |
| Remove members / ban | ✓ | ✓ (not owner/other admins) | — |
| Edit group info (E2EE) | ✓ | ✓ | configurable |
| Create/revoke invite links | ✓ | ✓ | configurable |
| Approve join requests | ✓ | ✓ | — |
| Pin messages | ✓ | ✓ | configurable |
| Delete others' messages for everyone | ✓ | ✓ | — |
| Promote/demote admins | ✓ | — | — |
| Transfer ownership / delete group | ✓ | — | — |

Roles are stored server-side (needed to enforce commit policy) **and** mirrored in an
E2EE group-context extension signed by an admin's device; clients reject commits that
violate the E2EE-held policy even if the server accepted them.

## 3. Membership flows

- **Intent first (implemented)**: adding someone — at creation, by an admin, after an
  invitation is accepted or a join request is approved — is first an encrypted
  `group_members {add}` message from a permitted sender; only then does a permitted device
  commit the Add. Removals send `group_members {remove}`.
- **Add**: admin device claims KeyPackages for all of the new member's devices → Add
  commit + Welcomes. Server checks: actor is permitted; target's privacy setting
  "who can add me to groups" (everyone / contacts / nobody → invite instead); target has
  not blocked actor; group size cap.
- **Invite link**: `https://<domain>/g/<token>`; token 128-bit random, stored hashed, with
  expiry/max uses; the link reveals only group name + member count **if** the group owner
  chose to publish a preview (the preview is then server-protected, not E2EE).
- **Join request** (approval mode): request stored server-side; an admin approves → admin
  device adds the requester.
- **Leave**: member's device proposes Remove for all own devices; any member's device
  commits (the server nudges online admins/members to commit pending proposals).
- **Ban**: Remove + server-side ban row; banned user cannot rejoin via links.
- **Ownership transfer**: owner selects an admin; confirmed by both; E2EE policy updated.
  If the owner deletes their account, ownership passes to the longest-tenured admin, else
  longest-tenured member.

## 4. Group features

Pinned messages, announcements-only mode, polls, reactions, mentions, replies, threads
(P2 — thread = `thread_root_id` field on messages, rendered in a side panel), disappearing
timer, group moderation (admins delete-for-everyone; report to Tessera per ADR-021).

## 5. Communities

```
Community (server-known container, public or private)
 ├─ Announcements   → broadcast-style large room (server-protected) or E2EE group if ≤1,024
 ├─ General         → E2EE group (≤1,024) or large room (labelled "not end-to-end encrypted")
 ├─ Discussion spaces (0..n)
 ├─ Private spaces  → E2EE groups restricted to a role
 ├─ Moderation      → E2EE group of moderators
 ├─ Members, Roles (bitset permissions, ordered by position — Discord-like hierarchy)
 └─ Rules, verification gate (accept rules, account age ≥ N days, verified email/phone)
```

- The community owner chooses per-space whether it is **E2EE** or a **large room**; this
  is permanent for that space and displayed prominently.
- Discovery: public communities listed in directory search (name, description, member
  count, rules) — server-protected data.
- Community roles grant **server-side** permissions (create spaces, manage members) and
  map to E2EE group admin roles where the space is an E2EE group.
- Member verification: gate evaluated server-side before issuing a join; for E2EE spaces an
  existing member device performs the Add (automated by an online moderator/admin device
  or by any member device when policy says "auto-approve verified members").

**Open design risk (R-05):** E2EE spaces require an *online member device* to perform
Adds. For auto-join communities with no admin online, joins are delayed. Mitigation: MLS
external commits for spaces whose policy is "open to verified community members", where the
joiner commits itself using a server-published `GroupInfo` — the policy check must then be
enforced by all clients from the signed E2EE policy. Requires review (S-12).

## 6. Large rooms (non-E2EE)

Community spaces above the E2EE cap. Stored like channel posts (server-protected), with
membership-scoped read access, full-text search, moderation tooling, bots. Clear banner.

## 7. Tests required (Phase 7 exit)

Permission matrix (every role × action, server and client enforcement); concurrent
commits by two admins; add while target offline; remove while target sending; ban +
rejoin via link; invite expiry/max-uses; 1,024-member group commit/welcome timing on a
low-end Android Chrome profile; policy-violating commit accepted by a malicious server
fixture is rejected by clients.
