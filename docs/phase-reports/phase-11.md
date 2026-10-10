# Phase 11 report — Moderation and safety

**Status: GREEN locally; pending the franking review (S-10) and legal confirmation of the
deadlines (L-05).** Verified 2026-10-10. CI has not run, because the branch still cannot be
pushed (GitHub returns 403 for the Claude app).

People can block and report; reports of end-to-end encrypted messages carry only what the
reporter selects, sealed to Tessera's moderation key, and are **verified** by message franking
(the server can prove the reported text is what the sender's device sent, without being able to
read anything else). Reports, grievances and legal orders become cases with legal deadlines;
staff act along an enforcement ladder with a second reviewer for bans; people are told why and
can appeal to someone else. Design and trade-offs: **ADR-049** and [moderation.md](../moderation.md)
§0.

## Results

| Gate | Result |
|---|---|
| Format, lint, typecheck, build | pass |
| Unit tests | **598 TypeScript** (api 375, web 136, ui 59, platform 15, shared 7, realtime 3, validation 3) + **75 Rust** (crypto core unchanged) |
| Integration (real PostgreSQL + Valkey + S3-compatible store + coturn) | **173 passed** (api 156, of which 22 moderation; realtime 17); 2 skipped (IPv6 TURN test without IPv6 here; opt-in channel scale test) |
| End-to-end (Chromium, production build, strict CSP + Trusted Types, real services) | **44 passed in each of 3 consecutive full runs** (3 new moderation tests; axe audit extended); 1 skipped (opt-in call load test) |
| Mutation checks | **22 of 22** seeded faults caught by the moderation suite (block paths ×5, second reviewer, approver role, appeal independence, evidence scoped to its case, abuse-material evidence legal-only, suspension gate, breach recorded once, commitment must open, tag must verify, automatic action only for a proven sender, distinct reporters, new-account limit, legal hold keeps evidence, suspension revokes sessions, harmful links in posts, legal-order role, bundle conversation binding) + the gateway typing filter |
| Accessibility (axe) | no violations on the grievance page, account status, the report dialog, the moderation queue and a case |
| OpenAPI | 170 paths, 201 operations (27 new paths; 31 new routes) |
| `pnpm audit --prod` / gitleaks | no known vulnerabilities / no leaks |

### Exit criteria

| Criterion | Evidence |
|---|---|
| Abuse suite | moderation.md §10 table: rate-limit bypass (second session and address; IPv6 /64 rotation), blocks on every path, report-bundle integrity (verified, tampered, forged tag, foreign binding, garbage), no access to unreported content, appeal flow, audit completeness |
| SLA timer tests | every category's deadlines exact to the millisecond; sweeps just before and just after each deadline; acknowledgement stops the acknowledgement clock; each breach recorded once; most urgent first |

## Delivered

- **API** (`modules/moderation`, migration `0012_moderation.sql`, 31 routes):
  - Blocks, enforced in messaging (new chats, sends both ways), calls, group adds, presence and
    the realtime gateway's typing fan-out.
  - Reports with HPKE-sealed bundles, franking verification, server snapshots of public content,
    "also block", the reporter's own report list.
  - Message franking: commitments accepted on send, tags issued with a rotatable key ring, both
    delivered with each message.
  - Cases with deadlines by category, a singleton sweeper (breaches, evidence retention, legal
    hold), queue and case detail, recorded evidence views (abuse-material matches: legal only).
  - Enforcement ladder, second review with step-up, reversal, dismissal, notices by email and in
    the app, a suspension gate for every signed-in route except status, appeals, sessions and
    sign-out.
  - Appeals (30 days, an independent reviewer); grievance officer form (public, per-address
    limit, emailed reference and outcome); legal orders (legal role, 3 h, legal hold); monthly
    transparency figures.
  - Link blocklist (k-anonymous prefix and hash lookups; refused in public posts and comments);
    exact-hash abuse-media list with the proven-sender rule; new-account limits; behaviour
    signals.
  - Staff roles from the operator command `staff` (grant with expiry, revoke, list; audited).
- **Web**:
  - Franking on every sent message; the commitment and the server's tag are kept with each
    received message on the device.
  - Report dialog in chats (choose messages, earlier context, files; sealed on the device), report
    buttons for people, groups, channels, posts, comments and communities; block and unblock in
    chat details; blocked people in Privacy.
  - Account status page (decisions, appeals, your reports); a suspended account sees only this
    page after signing in; public `/grievance` page.
  - Harmful-link warnings on received messages, checked on the device.
  - Moderation console for staff: queue with deadline countdowns, case view (reports, sealed
    evidence with blurred images, actions, approvals, reversal, notes, closing, earlier decisions,
    timeline), appeals, harmful links, legal orders, transparency figures, abuse-hash import.

## Defects found and fixed during the phase

1. **A send could deadlock the database pool**: the direct-chat block check called the
   moderation module while the send transaction held the conversation lock and a connection;
   under concurrent senders every connection waited on another. Found by the existing
   concurrent-send test; the check now runs before the transaction.
2. **Audit entries for blocklisted hosts would have failed** (the audit target is a UUID
   column); the host is now in the entry's details.
3. **A new staff member had to wait 30 seconds** before the console appeared (the empty role set
   was cached); only non-empty role sets are cached now, so grants apply at once and revocations
   within 30 seconds.
4. **A known-abuse match on any file could have triggered automatic suspension** while a
   different, harmless file was the one attested by a verified message; the automatic action now
   requires the matching file itself to be attested.
5. Two tests passed by accident (found by mutation): evidence through another case's id was
   refused only because of an unrelated lookup, and the bundle's inner conversation check was
   masked by the HPKE binding. Both tests now isolate the rule they check.

## Not met / deferred (tracked)

- **Message-requests inbox** for first messages from strangers (moderation.md §2) — before public
  beta.
- **Perceptual hashing** and reporting to authorities (L-12); exact SHA-256 misses re-encoded
  media.
- **Lookalike-domain / homograph detection**, public-upload malware scanning (no public uploads
  yet), risk scores and CAPTCHA-style challenges (Phase 12/15).
- **Admin console with corporate SSO** (Phase 12); until then roles come from the operator
  command and the console lives in the app.
- Moderator wellbeing controls beyond blur-by-default (grayscale, exposure limits).
- Legal confirmation of the deadlines (L-05) and of notice wording (L-04, L-13).

## Security implications (threat-model delta)

- **Mitigated:** fabricated reports of encrypted messages (franking; tamper → unverified);
  moderators browsing conversations (no route; evidence only through its case; every view
  audited); single-person bans and legal referrals (second reviewer with step-up); suspended
  accounts continuing to act (sessions revoked, server-side gate); harassment after blocking
  (every path); report floods and brigading (per-person limits, distinct reporters, automated
  effect limited to 24 h and reviewed); first-week spam; phishing links (public: refused; chats:
  private warnings).
- **Residual:** the HPKE private key opens every reported bundle (KMS custody; reported content
  only); the server learns who reported or blocked whom and when; reporters choose what to
  include; exact hashing misses altered media; coordinated reporting can impose a 24 h
  restriction; staff roles depend on database operators until Phase 12; messages sent before this
  phase cannot be verified.
