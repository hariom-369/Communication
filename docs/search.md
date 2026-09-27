# Search

Status: PROPOSED · Decision: ADR-025

## 1. Server-side search (non-E2EE data only)

| Target | Matching | Privacy filter |
|---|---|---|
| Users | exact username (primary); prefix match on username/display name only for users who opted into discoverability; phone exact lookup if enabled (rate-limited) | discoverability settings, blocks |
| Groups | only groups with a public preview (owner opt-in) | — |
| Channels | handle, title, description (public channels) | removed/suspended excluded |
| Communities | name, description, tags (public) | — |
| Public posts | channel posts and large-room messages in public spaces | removed excluded |

Implementation: PostgreSQL `tsvector` (language configs incl. `simple` for Indic scripts
initially) + `pg_trgm` for fuzzy/prefix; ranking by relevance + popularity signals.
Migration trigger to OpenSearch: p95 > 300 ms or > 50M public documents; indexing via
outbox consumer, never dual-write.

Anti-enumeration: rate limits per account/IP; minimum query length 3; results capped;
no "search all users by name" for users who aren't discoverable.

## 2. Private (E2EE) message search — on device only

- Crypto worker maintains a local inverted index (e.g. MiniSearch/FlexSearch-like
  structure, stored encrypted in IndexedDB) of decrypted messages on that device.
- Index covers messages present on the device (including restored backup history).
- No plaintext, tokens, or hashes of words are uploaded. No server-side "encrypted search"
  schemes (their leakage profiles are not acceptable without specialist review).
- Limitation: search on a new device covers only history transferred/restored to it.
