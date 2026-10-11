# Review register — assumptions, risks, specialist reviews, legal reviews

Status: OPEN. An ADR cannot be ACCEPTED while one of its items here is open.

## 1. Specialist security / cryptography review (S-items)

**Ready for review (Phase 4).** S-01..S-04 now have working code to review:
`packages/crypto-core` (Rust: `client.rs` trust checks and group handling, `identity.rs`
certificates, `safety.rs`, `padding.rs`, fuzz targets), `apps/web/src/crypto` (worker, encrypted
local store), `apps/web/src/messaging/e2ee.ts` (group creation, membership sync, key-change
handling), `services/api/src/modules/keys` and the commit/Welcome paths in
`services/api/src/modules/messaging`. Deviations from the design are listed in
[crypto-design.md §0](crypto-design.md) and ADR-039..041. Nothing ships to users before sign-off.

**Ready for review (Phase 5).** S-04 (device linking, messages-only devices) and S-06 (backups):
`packages/crypto-core/src/{link,backup,base32}.rs`, the linking/backup parts of `client.rs` and
`client/multidevice_tests.rs`, fuzz target `backup`; `apps/web/src/messaging/e2ee.ts` (linking,
backup orchestration), `apps/web/src/lib/webauthn.ts` (PRF); `services/api/src/modules/keys`
(links, devices) and `services/api/src/modules/backups`. Deviations: ADR-042.

**Ready for review (Phase 14).** S-03 (code delivery): `packages/crypto-core/src/release.rs`
(manifest verification), `apps/web/src/sw/release.ts` (what the service worker trusts, installs
and serves), `apps/web/scripts/release.mjs` (signing, SRI), `apps/web/scripts/verify-release.mjs`
(monitor); the honest limits are in e2ee.md §7 and ADR-052.

| ID | Item | Blocks | Why it needs a specialist |
|---|---|---|---|
| **S-01** | Protocol choice (MLS/OpenMLS vs libsignal vs others), OpenMLS version & crypto provider (RustCrypto vs libcrux), use of PublicMessage for handshakes, DS rules | ADR-004, Phase 4 | Foundational; errors here compromise all private content |
| **S-02** | Deploying X-Wing hybrid ciphersuite without final IANA code point; migration plan | ADR-005 | PQ agility and draft-standard risk |
| **S-03** | Web client: WASM crypto in worker, IndexedDB at-rest scheme, code-delivery mitigations (signed manifest, SW pinning) | ADR-006, 018, Phase 4/14 | Browser threat model is subtle; honest claims needed |
| **S-04** | ASK cross-signing, device certificate format & validation, trusted/untrusted devices, safety-number derivation, TOFU and key-change UX | ADR-007, Phase 4/5 | Prevents ghost-device attacks; UX affects real security |
| **S-05** | Media encryption construction and metadata (secretstream, hashes, blob↔conversation linking) — **ready for review (Phase 6)**: `packages/crypto-core/src/media.rs`, fuzz target `media`, `apps/web/src/crypto/engine.ts` (slicing), `apps/web/src/messaging/{attachments,media-transfer}.ts`, `apps/web/src/pages/chats/AttachmentView.tsx` (display allow-list), `services/api/src/modules/media`; deviations in ADR-043 | ADR-013, ADR-043 | Construction review |
| **S-06** | Backup key hierarchy, passkey PRF wrapping, rollback detection | ADR-014 | Recovery/security trade-off |
| **S-07** | Key transparency design (e.g., AKD-style auditable directory) | Post-GA | Complex, research-grade |
| **S-08** | Group-call E2EE (SFrame keying from MLS exporter, audio-level header leakage, re-key timing). **Implemented in Phase 9 (ADR-047) — for review:** RFC 9605 §5.2 keying with the call ID as exporter context; VP8 payload header left in the clear as authenticated metadata; one counter per device across tracks; 3-epoch receive window; SFrame plugged in through the SFU client's custom E2EE-manager hook (insertable streams in Chromium); audio-level extension still visible to the SFU | ADR-017, ADR-047 | Media E2EE subtleties |
| **S-09** | Metadata protection (sealed-sender-like delivery) | Post-GA | Research |
| **S-10** | Message franking for verifiable E2EE abuse reports. **Implemented in Phase 11 (ADR-049) — for review:** HMAC-SHA256 commitment under a per-message key inside the content; server tag over length-prefixed delivery fields with a rotatable key ring (`services/api/src/platform/franking.ts`); sender side `apps/web/src/messaging/franking.ts`; verification and HPKE report bundles `services/api/src/modules/moderation/moderation.ts` (`#openBundle`), `apps/web/src/moderation/report-bundle.ts`; questions: binding of context messages, commitment over JSON text (canonicalisation not needed: the exact bytes are committed), reporter-chosen selection | ADR-021, ADR-049 | Cryptographic commitment design |
| **S-11** | Private contact discovery (if phone numbers enabled) | ADR-031 | Enumeration/privacy |
| **S-12** | Group policy in the MLS group context (`0xF0A2`) and client-side commit authorisation; intent-gated adds; community space eligibility and auto-approve; MLS external commits for open community spaces | ADR-044, ADR-045, groups.md §0/§5 | Authorization rules, ghost-member resistance, owner-left takeover, membership without an online admin |
| **S-13** | External penetration test + cryptographic audit of implementation. **Scoping brief ready (Phase 16):** [security/audit-brief.md](security/audit-brief.md); our own review and ASVS self-assessment: [security/review.md](security/review.md), [security/asvs.md](security/asvs.md) | Public beta | Independent assurance |
| **S-14** | Admin plane. **Implemented in Phase 12 (ADR-050) — for review:** OIDC client (`services/api/src/modules/admin/oidc.ts`: PKCE, state, nonce, flow storage, email/domain checks, subject binding in `admins.ts`); WebAuthn policy (`keys.ts`: single-device flags, UV, `packed` attestation chain to configured vendor roots, AAGUID extension; revocation via FIDO MDS not consulted); session handling (`sessions.ts`); the authorization matrix (`rbac.ts`, enforced in `platform/http/admin-routes.ts` before body parsing; matrix test in `admin.integration.test.ts`); four-eyes races (`approvals.ts` atomic claim, DB check); purpose binding (`service.ts`) | ADR-050 | Privileged access is the highest-impact insider and takeover path |

## 2. Legal review (L-items) — qualified Indian counsel

| ID | Item | Impact |
|---|---|---|
| **L-01** | Name/trademark/domain clearance for product (codename "Tessera") | Branding |
| **L-02** | Do DoT SIM-binding directions apply (app-based communication service)? If yes: native-app requirement, ~6-hour web re-auth, timelines (reported extension to 31 Dec 2026) | **Product shape, web-first strategy** |
| **L-03** | Telecom Cyber Security Amendment Rules 2025 — are we a TIUE if we use phone numbers? MNV obligations/costs | Sign-up design (ADR-030) |
| **L-04** | IT Rules Rule 4(2) traceability vs E2EE when approaching SSMI threshold; litigation status; strategy | **Existential for E2EE messaging at scale in India** |
| **L-05** | IT Rules 2026 amendment obligations: 3 h / 2 h takedowns, 7-day grievances, SGI labelling, pending further amendments | Moderation operations |
| **L-06** | DPDP children's data: verifiable parental consent; 18+ launch; age assurance expectations | Audience |
| **L-07** | DPDP notices, consent, languages, rights timelines, Significant Data Fiduciary risk | Privacy center |
| **L-08** | Retention: CERT-In 180-day logs, DPDP 1-year log retention and erasure duties, inactivity erasure, 30-day mailbox | Data lifecycle |
| **L-09** | Breach notification: DPDP (72 h Board report) + CERT-In (6 h) process | Incident response |
| **L-10** | If libsignal were chosen (or any AGPL component): obligations and open-source strategy | ADR-004 alternative |
| **L-11** | Subscriptions: RBI e-mandates, GST, consumer protection/dark patterns, refunds, app-store rules | Billing |
| **L-12** | CSAM detection & reporting obligations; hash-list licensing; evidence handling | Moderation |
| **L-13** | Law-enforcement request handling; transparency reporting | Operations |
| **L-14** | AI provider contracts, data residency, SGI labelling for AI features | AI features |
| **L-15** | Terms of Service, Privacy Policy, Community Guidelines, grievance officer appointment | Launch |

## 3. Key assumptions

| ID | Assumption | If wrong |
|---|---|---|
| A-01 | Web-first launch is acceptable to the business and legally viable (see L-02) | Re-plan to native-first; architecture already protocol-first |
| A-02 | OpenMLS remains maintained and audited | Crypto provider abstraction permits switching MLS implementation (e.g., mls-rs, Apache-2.0/MIT) |
| A-03 | Launch audience India, 18+ | Compliance scope expands |
| A-04 | AWS India regions meet data-residency needs | Re-evaluate provider |
| A-05 | Team includes or contracts a cryptography reviewer and a security engineer from Phase 1 | Phase 4 cannot start |
| A-06 | Load assumptions in scaling.md | Capacity re-plan after Phase 15 |

## 4. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-01 | Regulatory requirement incompatible with E2EE (traceability) | M | Critical | Early legal strategy (L-04); transparency with users |
| R-02 | SIM-binding makes web-only product non-compliant | M | High | Resolve L-02 before Phase 2 sign-up design freeze |
| R-03 | Crypto integration bug undermines E2EE | M | Critical | Library-only crypto, reviews S-01..S-06, fuzzing, audit S-13 |
| R-04 | Scope too large for timeline | H | High | Phased gates; launch-critical subset defined in prd.md §9 |
| R-05 | E2EE communities need online admin devices for joins | M | Medium | External commits (S-12) or UX for pending joins |
| R-06 | Browser limitations (background sync, push on iOS, encoded transforms) degrade UX | H | Medium | Documented limitations; desktop/native roadmap |
| R-07 | Cost of bandwidth (media/calls) at scale | M | High | Tier limits, TURN/SFU optimisation, scaling.md stage 4 |
| R-08 | Abuse in E2EE spaces undetectable server-side | H | High | Metadata signals, user reports, franking, friction for new accounts |
| R-09 | Web code-delivery compromise | L | Critical | Signed releases, transparency, desktop app |
