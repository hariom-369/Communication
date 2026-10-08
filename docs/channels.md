# Broadcast channels

Status: Phase 8 IMPLEMENTED (except media, reports/takedowns, notifications — see §0) ·
Decisions: ADR-012 (channels are not E2EE), ADR-046

## 0. What is implemented (Phase 8)

Channels module (`services/api/src/modules/channels`, migration `0009_channels.sql`, 35 routes)
and web UI (`apps/web/src/pages/channels`): public and private channels with `@handle`, directory
search, subscribe/unsubscribe, invite links for private channels; posts (text, polls, server-fetched
link previews) as published, scheduled or draft; edit and removal; reactions from a fixed set;
anonymous or public polls; comments with on/off and slow mode; per-channel full-text search;
admin roles (§3) and delayed ownership transfer; aggregate analytics (views, reactions,
comments, joins/leaves). Not yet: media in posts (Phase 11 pipeline), reports and takedown SLA
timers (Phase 11), notifications (Phase 10), synthetic-content labels (Phase 11), realtime
"updated" hints (pages poll). Avatars are not implemented.


## 1. Scope

Public and private one-to-many channels: handle (`@name`), title, description, avatar,
subscriber count, posts (text, media, polls), reactions, comments, scheduled posts,
admin roles, analytics, moderation, reporting.

Channels are **server-protected**: content is readable by Tessera for delivery, search,
moderation, legal compliance and analytics. The UI states: "Channels are not end-to-end
encrypted. Posts are visible to Tessera and to anyone who can view this channel."

## 2. Separation from private messaging

| Aspect | Private messaging | Channels |
|---|---|---|
| Module | `messaging` | `channels` |
| Storage | E2EE mailbox, ≤30 days | `channel_posts`, retained until deleted |
| Delivery | push per device | **fan-out on read**: subscribers fetch feeds; realtime sends lightweight "channel updated" hints only to online subscribers who have the channel open or pinned |
| Media | client-encrypted blobs, signed URLs | scanned, transcoded, CDN-cached public URLs (private channels: signed CDN URLs) |
| Search | on-device | server-side (Postgres FTS → OpenSearch) |
| Scale unit | ≤1,024 members | 1M+ subscribers |

A channel with 1M subscribers must never trigger 1M synchronous writes; publishing a post
is one insert + cache invalidation + a sampled notification job (subscribers who enabled
notifications, batched, rate-controlled).

## 3. Admin roles (bitset permissions)

`POST`, `EDIT_ANY`, `DELETE_ANY`, `MANAGE_COMMENTS`, `VIEW_ANALYTICS`, `MANAGE_ADMINS`,
`EDIT_CHANNEL_INFO`. Owner has all; ownership transfer requires re-auth + 2FA and a
24-hour cool-down (anti-takeover).

## 4. Posts

- States: draft → scheduled → published → (edited) → removed (by admin or moderation).
- Scheduled posts: `publish_at` + job queue with at-least-once execution; publish step is
  idempotent (`status` CAS draft/scheduled → published).
- Comments: optional per channel; comments are a thread per post, rate-limited, moderated,
  with slow-mode option.
- Reactions: one per user per post; counts materialised asynchronously (counter table
  updated by batched job, eventually consistent within 5 s).
- Polls: server-side tallies; anonymous or public voting chosen at creation.
- Links: server fetches previews via the **SSRF-hardened fetcher** ([security.md §6](security.md));
  link reputation checks (phishing/malware lists).

## 5. Subscriber counts and analytics

Counts maintained incrementally; displayed rounded (e.g. "12.4K"). Analytics: views
(deduplicated per user per post per day, counted in Valkey HyperLogLog → daily rollups),
reactions, shares, subscriber growth. **No per-subscriber viewing history is exposed** to
channel owners.

## 6. Moderation hooks

Report post/channel; automated classifiers on public content (spam, CSAM hash matching for
images, malicious URLs); takedown pipeline supporting IT Rules timelines (3 h for orders,
2 h for NCII/deepfake reports — see [compliance.md](compliance.md)); synthetic-content
labels (SGI) where declared or detected; channel-level restrictions (demonetise, remove
from discovery, suspend).

## 7. Tests required (Phase 8 exit)

Feed pagination under concurrent publishing; scheduled post exactly-once visibility;
1M-subscriber synthetic publish load (no per-subscriber writes); permission matrix;
private channel media not accessible without signed URL; takedown SLA timers.
