# Research sources

This file records the sources behind Phase 0 decisions. Two classes are distinguished honestly:

- **[V] Verified in the 2026-09-27 research pass** — current status checked against a live source.
- **[K] Specification knowledge** — standards whose content is stable and well known to the
  team; each MUST be re-read from the primary source by the engineer implementing the
  relevant phase (tracked as a Phase-entry task in [implementation-plan.md](implementation-plan.md)).

Secondary sources (news, law-firm summaries) were used only to discover the existence and
status of regulations. **Every regulatory item must be confirmed against the Gazette /
ministry text by qualified counsel** — see [compliance.md](compliance.md).

## Cryptography and E2EE

| Source | Class | Used for |
|---|---|---|
| Signal specifications: X3DH, PQXDH, Double Ratchet, Sesame, XEdDSA — https://signal.org/docs/ | K | Baseline properties we must match (async setup, FS, PCS, multi-device fan-out model), threat assumptions |
| Signal blog, "Signal Protocol and Post-Quantum Ratchets" (SPQR, Oct 2025) — https://signal.org/blog/spqr/ ; https://github.com/signalapp/SparsePostQuantumRatchet | V | State of the art: ML-KEM-768 based "triple ratchet"; informs PQ requirement (ADR-005) |
| libsignal repository and license — https://github.com/signalapp/libsignal (AGPL-3.0); issue #691 on third-party use | V | AGPL network clause; "unsupported outside Signal"; no official WASM target (ADR-004) |
| RFC 9420 — The Messaging Layer Security (MLS) Protocol | K | Chosen protocol (ADR-004) |
| RFC 9750 — The MLS Architecture | K | Delivery Service / Authentication Service responsibilities; server ordering of commits |
| OpenMLS — https://openmls.tech/ , https://book.openmls.tech/ , SRLabs security assurance assessment (sponsored by Sovereign Tech Agency) | V | Implementation choice; WASM support; audit exists |
| OpenMLS post-quantum post (2024) and `draft-ietf-mls-pq-ciphersuites` | V | X-Wing (0x004D, no IANA code point yet) and provisional ML-KEM/ML-DSA suites (0xF001–0xF00B) — ADR-005 |
| Wire core-crypto architecture — https://github.com/wireapp/core-crypto | V | Production evidence of OpenMLS on web/WASM; their note that WASM at-rest keystore encryption is not audited |
| vodozemac (Olm/Megolm) + Least Authority audit (2022); Soatok, "Cryptographic Issues in Matrix's Rust Library Vodozemac" (Feb 2026) | V | Evaluated and rejected alternative (ADR-004) |
| RFC 9605 — SFrame | K | Group-call media E2EE (ADR-017) |
| RFC 9180 — HPKE | K | Used inside MLS; used for backup key wrapping to devices |
| RFC 8446 (TLS 1.3), RFC 6797 (HSTS) | K | Transport security |
| libsodium `crypto_secretstream_xchacha20poly1305` documentation | K | Chunked media/backup encryption (ADR-013) |
| Facebook "Messenger Secret Conversations" whitepaper; Grubbs, Lu, Ristenpart, "Message Franking via Committing AEAD" (CRYPTO 2017) | K | Verifiable abuse reporting for E2EE (ADR-021) — requires cryptographer review |
| WhatsApp Security Whitepaper; WhatsApp "Encrypted Backups" whitepaper (HSM Backup Key Vault); WhatsApp Key Transparency (AKD) publications | K | Multi-device model, HSM-backed backup passwords, key transparency roadmap |
| Telegram MTProto documentation (cloud chats vs secret chats) | K | Contrast case: server-readable cloud chats; we do not adopt MTProto |
| Matrix spec: cross-signing, key backup | K | Cross-signing model for device verification (ADR-007) |

## Web platform, WebRTC, WebSocket

| Source | Class | Used for |
|---|---|---|
| W3C Web Authentication Level 3; WebAuthn PRF extension | K | Passkeys; passkey-assisted backup key wrapping (ADR-014) |
| W3C Web Cryptography API; Secure Contexts | K | Non-extractable wrapping keys; secure context requirement |
| W3C WebRTC 1.0, WebRTC Encoded Transform (`RTCRtpScriptTransform`) | K | Calls and frame-level E2EE |
| RFC 8825–8835 (WebRTC security architecture), RFC 5764 (DTLS-SRTP), RFC 8656 (TURN), RFC 8489 (STUN) | K | Call transport security |
| RFC 6455 (WebSocket) and OWASP WebSocket Security Cheat Sheet | K | Origin validation, CSWSH defence |
| RFC 8030/8291/8292 (Web Push, message encryption, VAPID) | K | Notifications |
| W3C Content Security Policy Level 3; Trusted Types; Subresource Integrity | K | XSS defence, script integrity |
| Fetch Metadata request headers | K | CSRF/XS-leak defence |

## Security frameworks

| Source | Class | Used for |
|---|---|---|
| OWASP ASVS 5.0 (May 2025) | K | Primary verification standard; target Level 2 for all, Level 3 for auth/crypto/admin |
| OWASP MASVS 2.x | K | Future native clients |
| OWASP Cheat Sheets: Password Storage, Session Management, Authentication, CSRF, File Upload, SSRF, Logging | K | Specific control parameters (e.g. Argon2id minimums) |
| NIST SP 800-207 Zero Trust Architecture | K | Internal service authn, admin access model |
| NIST SP 800-63B (Digital Identity — Authentication) | K | Password policy, authenticator assurance |
| NIST FIPS 203 (ML-KEM), FIPS 204 (ML-DSA) | K | PQ primitives |
| SLSA v1.x, Sigstore, CycloneDX | K | Supply-chain controls |

## India — legal and regulatory (discovery only; counsel must confirm)

| Source | Class | Status found |
|---|---|---|
| Digital Personal Data Protection Act 2023; DPDP Rules 2025 | V | Rules notified 13 Nov 2025; phased: Board provisions immediate, consent managers ~12 months, core duties (notice, rights, safeguards, 72-hour breach report, retention/erasure) ~18 months (≈ May 2027) |
| IT Act 2000 and IT (Intermediary Guidelines and Digital Media Ethics Code) Rules 2021, with amendments to 2026 | V | 2026 amendment effective 20 Feb 2026: 3-hour removal on court/government order; 2-hour for non-consensual intimate imagery/deepfakes; synthetic-content (SGI) labelling; grievance resolution reduced to 7 days; SSMI threshold 50 lakh registered users; further draft amendments circulating |
| CERT-In Directions under s.70B(6), 28 April 2022 (+ FAQs) | K | Report specified incidents within 6 hours; maintain ICT logs for rolling 180 days within Indian jurisdiction; synchronise clocks to NIC/NPL NTP (or traceable); designate point of contact |
| Telecommunications Act 2023; Telecom Cyber Security Rules 2024; Amendment Rules 2025 (TIUE, Mobile Number Validation platform) | V | Apps using mobile numbers to identify users may be TIUEs subject to MNV |
| DoT directions on SIM binding for app-based communication services (Nov/Dec 2025) | V (secondary sources) | SIM must be present in primary device; web/companion sessions logged out ~every 6 hours; compliance date reportedly extended to 31 Dec 2026 |
| Consumer Protection Act 2019; Consumer Protection (E-Commerce) Rules 2020; CCPA Guidelines on dark patterns (2023) | K | Subscription disclosures, cancellation, no dark patterns |
| RBI e-mandate framework for recurring card/UPI payments | K | Premium subscriptions (AFA thresholds) |
| POCSO Act 2012; IT Act s.67B | K | CSAM reporting obligations |
