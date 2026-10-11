# Tessera architecture — Phase 0 package

Status: **PROPOSED — awaiting review.** Nothing in this package is approved until the
review gates in [`review-register.md`](review-register.md) are cleared.
Date of research pass: 2026-09-27.

## Reading order

| # | Deliverable (from Phase 0 brief) | Document |
|---|---|---|
| 1 | Product requirements document | [prd.md](prd.md) |
| 2 | Feature matrix (WhatsApp / Telegram / Signal / Discord-style) | [feature-matrix.md](feature-matrix.md) |
| 3 | System architecture | [architecture.md](architecture.md) |
| 4 | Database architecture | [database.md](database.md) |
| 5 | E2EE architecture | [e2ee.md](e2ee.md), [crypto-design.md](crypto-design.md), [encrypted-backups.md](encrypted-backups.md) |
| 6 | Multi-device architecture | [multi-device.md](multi-device.md) |
| 7 | WebSocket architecture | [realtime.md](realtime.md), [messaging.md](messaging.md) |
| 8 | WebRTC architecture | [calling.md](calling.md) |
| 9 | Media architecture | [media.md](media.md) |
| 10 | Authentication architecture | [authentication.md](authentication.md) |
| 11 | Security threat model | [threat-model.md](threat-model.md), [security.md](security.md) |
| 12 | Abuse / moderation architecture | [moderation.md](moderation.md) |
| 13 | Admin architecture | [admin.md](admin.md) |
| 14 | Billing architecture | [billing.md](billing.md) |
| 15 | Deployment architecture | [deployment.md](deployment.md), [disaster-recovery.md](disaster-recovery.md), [observability.md](observability.md) |
| 16 | Scaling strategy | [scaling.md](scaling.md), [capacity.md](capacity.md) (measured), [load-testing.md](load-testing.md) |
| 17 | Compliance-readiness checklist | [compliance.md](compliance.md) |
| 18 | Testing strategy | [testing.md](testing.md) |
| 19 | Repository structure | [repository-structure.md](repository-structure.md) |
| 20 | Phase-by-phase implementation plan | [implementation-plan.md](implementation-plan.md) |

Supporting documents:

- [decisions.md](decisions.md) — architecture decision log (ADR-style): decision, alternatives, trade-offs
- [review-register.md](review-register.md) — assumptions, risks, **specialist security review** and **legal review** items
- [research-sources.md](research-sources.md) — primary sources consulted and what was taken from each
- [phase-reports/](phase-reports/phase-1.md) — exact status reported at the end of each implementation phase
- [groups.md](groups.md), [channels.md](channels.md) — groups, communities, channels
- [privacy.md](privacy.md) — privacy center and **exact server-visible metadata inventory**
- [notifications.md](notifications.md), [search.md](search.md), [ai.md](ai.md)
- [performance.md](performance.md) — web performance budgets; [accessibility.md](accessibility.md) — WCAG 2.2 AA audit

## Conventions used in every document

- **Decision** references look like `ADR-012` and resolve to [decisions.md](decisions.md).
- **Review items** look like `S-04` (security specialist) or `L-07` (legal) and resolve to
  [review-register.md](review-register.md).
- **MUST / SHOULD / MAY** follow RFC 2119 meaning.
- "E2EE" is used only for data whose plaintext and keys never reach Tessera servers.
  Data that is encrypted at rest by the server (server holds keys) is called
  **server-protected**, never "encrypted" without qualification in user-facing text.

## The five most important findings of the research pass

1. **Protocol choice (ADR-004).** libsignal is the most mature Signal-protocol
   implementation (PQXDH + SPQR "triple ratchet" since Oct 2025), but it is AGPL-3.0, Signal
   states use outside Signal apps is unsupported, and there is no official browser/WASM
   build. For a web-first commercial product we recommend **MLS (RFC 9420) via OpenMLS**
   (MIT, independently audited by SRLabs, compiles to WASM, used in production by Wire)
   for both 1:1 and group conversations. MLS delivers the required Signal-style
   properties (per-device keys, prekey-like KeyPackages, async setup, FS, PCS) with native
   multi-device and efficient groups. **This is the single most important decision and
   requires cryptographer sign-off (S-01).**
2. **Web E2EE has a code-delivery trust problem.** A server that serves the JavaScript can
   serve malicious JavaScript. Mitigations are documented ([e2ee.md §7](e2ee.md)); a
   desktop/native client is the higher-assurance path. We will not market the web client's
   E2EE as equivalent to native.
3. **Indian telecom rules may directly affect the product shape.** DoT's SIM-binding
   directions (in force for app-based communication services; deadline reportedly
   extended to 31 Dec 2026) require the registered SIM to be present on the primary device
   and **web sessions to be logged out every ~6 hours**. A web-first product using phone
   numbers as identifiers may be unable to comply without a native mobile app.
   The Telecom Cyber Security Amendment Rules 2025 (TIUE / Mobile Number Validation) may
   also apply. **Blocking legal review (L-02, L-03) before choosing phone number as an
   identifier.**
4. **IT Rules traceability vs E2EE.** Rule 4(2) of the IT Rules 2021 (first-originator
   identification for significant social media intermediaries providing messaging, ≥50
   lakh Indian users) is architecturally incompatible with E2EE as designed; it is under
   litigation. The 2026 amendments add 3-hour takedown for government/court orders,
   2-hour for non-consensual intimate imagery/deepfakes, 7-day grievance resolution and
   synthetic-content labelling. **Legal review L-04, L-05.**
5. **DPDP Rules 2025** were notified 13 Nov 2025 with core duties (notice, rights,
   security safeguards, 72-hour breach reporting, retention) in force ~May 2027.
   Children's data (verifiable parental consent under 18) is a significant product
   constraint for a public messenger. **Legal review L-06..L-09.**
