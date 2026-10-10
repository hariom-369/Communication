# Threat model

Status: PROPOSED — to be re-reviewed at the end of every phase and by the external security
reviewer before public beta. Method: asset/actor analysis + STRIDE per trust boundary, then
the threat register below.

Scales: **Probability** L (unlikely in 3 years) / M (plausible) / H (expected).
**Impact** L (minor, contained) / M (some users, recoverable) / H (many users or
confidentiality of private content) / C (critical: platform-wide compromise of
private content or safety).

## 1. Assets

| Asset | Sensitivity |
|---|---|
| A1 Private message/call/media plaintext | Critical — only on endpoints |
| A2 Device private keys, ASK, BRK, recovery keys | Critical — only on endpoints / with user |
| A3 Account credentials (password hashes, passkey public keys, TOTP secrets) | High |
| A4 Session tokens | High |
| A5 Social graph & metadata (who/when/IP/groups) | High |
| A6 Profile data, email, phone | High (personal data under DPDP) |
| A7 Channel/community public content | Medium (integrity, availability) |
| A8 Admin capabilities and audit log | High |
| A9 Payment and billing data (tokens only; card data never touches us) | High |
| A10 Build pipeline and signing keys | Critical (can compromise A1 via code delivery) |

## 2. Trust boundaries

TB1 Browser ↔ edge (Internet) · TB2 Edge ↔ API/realtime · TB3 Services ↔ datastores ·
TB4 Main thread ↔ crypto worker · TB5 App origin ↔ user-content origin ·
TB6 Staff ↔ admin plane · TB7 CI/CD ↔ production · TB8 Tessera ↔ third parties
(push services, payment, email/SMS, SFU/TURN clients).

## 3. STRIDE summary per boundary

| Boundary | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| TB1 | phishing, stolen cookies | MITM (TLS/HSTS) | audit log | metadata to network (TLS) | DDoS (WAF/Shield) | — |
| TB2 | forged realtime tickets | request tampering (validation) | request IDs | error leakage | resource exhaustion (limits) | authz bypass (policy tests) |
| TB3 | service impersonation (mTLS/IAM) | SQLi (parameterised) | DB audit | DB leak (hashing, E2EE) | pool exhaustion | over-privileged roles |
| TB4 | XSS driving worker | state corruption | — | key exfil | — | — |
| TB6 | admin account takeover | evidence tampering (hash chain) | immutable audit | insider browsing | — | privilege escalation (RBAC, 4-eyes) |
| TB7 | malicious PR/dependency | artifact tampering (signing) | provenance | secret leak | — | CI → prod creds |

## 4. Threat register

| ID | Threat | Prob. | Impact | Mitigation | Residual risk | Detection | Recovery |
|---|---|---|---|---|---|---|---|
| T-01 | **Malicious user** sends spam, harassment, malware | H | M | Rate limits, new-account throttles, block/report, privacy controls (who can message/add me), client-side file warnings | Private-chat abuse invisible to us until reported | Report volume, graph signals (many first-contacts), rate-limit hits | Restrictions/suspension; blocklists |
| T-02 | **Stolen session** cookie (XSS, malware, shared PC) | M | H | HttpOnly `__Host-` cookie, CSP/Trusted Types, device-signature on key ops, session list + revoke, short idle on shared devices, new-login alerts | Attacker with cookie can use account (not read E2EE history without device keys) until revoked | Concurrent-use anomalies (IP/UA jumps), device-signature failures | Revoke sessions, rotate, notify |
| T-03 | **Compromised device** (malware, stolen unlocked) | M | H | Remote revoke, PCS via updates after removal, ASK rotation option, disappearing messages | Past messages on device exposed | User report, unfamiliar device in list | Revoke device; ASK rotate; re-key groups |
| T-04 | **Compromised server** (attacker controls API/DB) | L | C | E2EE (no plaintext/keys server-side), clients verify ASK-signed device certs (no ghost devices), clients enforce group policy, commits signed | Metadata exposed; could withhold/delay messages; could serve malicious web JS (T-17); could substitute ASK before first contact (TOFU) | Intrusion detection, integrity monitoring, key-transparency (future), client-side anomaly alerts | Incident response; key rotation; forced client update |
| T-05 | **Malicious administrator / insider** | M | H | Admin RBAC, JIT elevation, 4-eyes for sensitive actions, no admin access to E2EE content (impossible by design), immutable audit log, prod data access via break-glass only | Insider can see metadata within role scope | Audit alerting on unusual queries/bulk exports | Revoke access; legal; notify affected users as required |
| T-06 | **Database leak** | M | H | Argon2id+pepper hashes, hashed session tokens, E2EE ciphertext only, KMS-encrypted secrets, encryption at rest, minimal PII | Metadata + emails/phones exposed | DB access anomaly, canary records | DPDP breach process (72 h), CERT-In (6 h), force resets |
| T-07 | **Object-storage leak** | L | M | E2EE blobs + backups client-encrypted; Block Public Access; bucket policies; random keys | Public-content leak only; ciphertext sizes | S3 access logs/GuardDuty | Rotate, revoke URLs |
| T-08 | **MITM** on network | L | H | TLS 1.3, HSTS preload, E2EE independent of TLS, DTLS fingerprints via MLS | State-level CA compromise mitigated by E2EE (content), not metadata | CT log monitoring for our domains | Revoke certs |
| T-09 | **Phishing** for credentials | H | H | Passkeys first (phishing-resistant), no SMS 2FA, login alerts, brand-lookalike domain monitoring | Password-only users phishable | Login risk signals | Account recovery flow |
| T-10 | **Account takeover** (stuffing, reuse) | H | H | Breached-password check, rate limits, MFA prompts on risk, passkeys | Users without MFA | Credential-stuffing detection | Lock + reset + notify |
| T-11 | **QR/device-link phishing** (victim scans attacker's link QR) | M | H | Link confirmation shows device + location, explicit warning copy, new-device notices to contacts & own devices, trusted-device requirement | Social engineering can still succeed | New-device alerts, user report | Revoke device, ASK rotate |
| T-12 | **SIM-swap** | M | M | Phone is never sole factor; SMS not a 2FA factor; recovery requires multiple factors + waiting period | Phone-only recovery path does not exist by design | Carrier port signals (if MNV available), recovery requests | Cancel recovery from any session |
| T-13 | **Malicious browser extension** | M | H | Out of our control; CSP doesn't stop extensions; recommend desktop app; detect DOM tampering heuristics (limited) | High — extension with page access can read plaintext | Limited | User guidance |
| T-14 | **XSS** in web app | M | C | React escaping, no HTML rendering of user content, Trusted Types, strict CSP, user-content origin sandbox, crypto in worker | XSS could drive the worker to decrypt/sign | CSP reports, WAF | Hotfix deploy, revoke sessions if exploited |
| T-15 | **Cross-site WebSocket hijacking** | M | H | Origin allow-list, single-use tickets from CSRF-protected endpoint, no cookie auth on WSS | Low | Auth-failure metrics | — |
| T-16 | **Spam / bot account farms** | H | M | Sign-up friction by risk, email/phone verification, device attestation for native later, new-account limits, graph-based detection | Adaptive adversaries | Signup velocity, clustering | Mass action tooling |
| T-17 | **Web code-delivery compromise** (malicious JS served) | L | C | Signed reproducible releases, transparency log, SW signature pinning, CI hardening, 2-person release approval | Signing-key holder or coerced operator can still ship malicious code to web | Third-party manifest monitors | Revoke release, incident disclosure |
| T-18 | **DDoS** (L3/4/7) | H | M | CloudFront/Shield, WAF rate rules, autoscaling, per-route limits, WSS connection limits, TURN quotas | Large-scale attacks cost money/availability | Traffic anomaly alerts | Scale out, geo/ASN blocks |
| T-19 | **Supply-chain compromise** (CI, action, registry) | M | C | Pinned actions, OIDC short-lived creds, protected branches, signed artifacts, SLSA provenance, admission control | Upstream zero-day | Provenance verification failures | Rollback to last verified build |
| T-20 | **Malicious dependency** (typo-squat, hijacked maintainer) | M | C | Dependency review, install-script allow-list, `cargo deny`, lockfiles, minimal deps in crypto-core, OSV monitoring | Undetected malicious update | Diff review of lockfile changes | Pin, remove, rotate secrets |
| T-21 | **Metadata leakage** (social graph, timing, sizes) | H | M | Minimise retention, padding of ciphertext, relay calls option, no content in push, restricted internal access | Server sees who talks to whom and when | — | Retention limits bound exposure |
| T-22 | **Device theft** (locked) | M | M | Encrypted local store (LSK), OS lock screen, remote revoke, optional app lock (PIN, WebAuthn) | Browser profile on unlocked OS accessible | User report | Revoke device |
| T-23 | **Backup compromise** | L | H | Client-side encryption with 256-bit keys, no password-only mode, rollback detection, alerts on wrap changes | Recovery key theft = full backup access | Alerts on backup ops | Rotate BRK, delete old backups |
| T-24 | **Replay / duplicate messages** | M | L | MLS generation reuse guard, message_id dedupe, server idempotency | — | Dedupe counters | — |
| T-25 | **Malformed encrypted envelopes / parser bugs** | M | H | Rust parsing, length limits, fuzzing, no panics across WASM | Zero-days in dependencies | Crash telemetry (no content) | Patch release |
| T-26 | **Device impersonation** (register device for victim) | L | H | Device certificate must be ASK-signed; clients reject otherwise; device ops need session + device signature | Server compromise + TOFU window | Clients report cert validation failures | Revoke, investigate |
| T-27 | **KeyPackage exhaustion** | M | L | Claim rate limits, last-resort KeyPackage | Slightly weaker initial FS | Claim-rate alerts | Replenish |
| T-28 | **Legal compulsion / lawful access requests** | M | H | E2EE limits what can be produced; transparency report; legal review of each request | Metadata disclosure where legally compelled | Request tracking | — |

## 5. Assumptions

Endpoint OS and browser are not compromised (T-03/T-13 are residual); AWS/KMS operate as
documented; OpenMLS/libsodium are correct; users verify safety numbers only rarely (hence
key transparency on the roadmap).

## 6. Review cadence

Updated at each phase exit; full external review before public beta (S-13) and annually;
any new data flow or third-party integration requires a threat-model delta in its PR.

**Phase 5 delta (multi-device, backups).** New flows: link requests and sealed link payloads
relayed by the server, and encrypted backups plus wrapped keys stored by the server. The analysis
is in [phase-reports/phase-5.md](phase-reports/phase-5.md) §Security implications and ADR-042.
Residual risks: a user persuaded to approve an attacker's link code (T-11, mitigated by step-up,
wording, email and contact notices); a removed device with full access keeps the identity key
until "Start over"; backup rollback to an older authentic version is not yet detected.

**Phase 6 delta (attachments).** New flows: browser ↔ object storage with presigned URLs, and
blob ↔ conversation links on the server. The analysis is in
[phase-reports/phase-6.md](phase-reports/phase-6.md) §Security implications and ADR-043. Residual
risks: malware sent privately cannot be detected by Tessera (documented, media.md §3); the server
learns attachment sizes and which conversation they were sent to; a presigned download URL can be
used by whoever holds it for 5 minutes (it yields only ciphertext).

**Phase 7a delta (groups).** New flows: group policy commits, membership intents, invitations,
invite links and join requests. The analysis is in [phase-reports/phase-7.md](phase-reports/phase-7.md)
§Security implications and ADR-044. Mitigated: a malicious server adding a reader ("ghost
member") — devices add new users only with an authenticated intent from a permitted sender, and
every client rejects commits that the end-to-end policy does not allow; a server forging roles or
settings — the authoritative copy is in the MLS group context. Residual risks: the server sees
membership, roles and invite-link usage; it can delay or withhold members and unlist someone
(after which any member removes them); an optional invite-link preview title is readable by the
server; key-directory access now extends to everyone sharing a group.

**Phase 7b delta (communities).** New flows: community directory search, join with rules and
account-age gate, roles and moderation, community invite links, and server-driven removal from
spaces. Analysis in [phase-reports/phase-7.md](phase-reports/phase-7.md) and ADR-045. Mitigated:
role escalation (hierarchy and permission subset enforced server-side, tested), private
community enumeration (404 for non-members on every route), joining spaces outside one's roles
(eligibility checked on every path into a space). Residual: community container data is
server-readable by design; a malicious server can admit anyone to auto-approve spaces (documented
in the UI; default off); directory search exposes public community names to all users.

**Phase 8 delta (channels).** New flows: server-side fetching of user-supplied URLs (link
previews), public posting and commenting, scheduled publishing, view counting. Analysis in
[phase-reports/phase-8.md](phase-reports/phase-8.md) and ADR-046. Mitigated: SSRF (DNS-pinned
fetcher with a full deny-list, redirect re-validation, size/time caps; 65 SSRF tests, 6 mutation
checks); privilege escalation among channel admins (permission subset and owner-only rules,
tested); instant channel takeover (24 h cooling-off, re-authentication, audit); viewer tracking
(HyperLogLog aggregates only); counter hot spots (sharded). Residual: the fetcher runs in the API
process until it is isolated behind an egress proxy; spam and abuse in public comments rely on
rate limits, slow mode and admin moderation until Phase 11 reporting; channel content is
server-readable by design.

**Phase 9 delta (calls).** New flows: call signalling inside MLS messages, call records, TURN
relaying with short-lived credentials, an SFU forwarding end-to-end encrypted frames. Analysis in
[phase-reports/phase-9.md](phase-reports/phase-9.md) and ADR-047. Mitigated: a malicious server
substituting the DTLS fingerprint (offers and answers exist only inside MLS; a spliced foreign
offer is undecryptable; the presented certificate is checked against the MLS-delivered
fingerprint after DTLS, fail-closed — E2E and unit tested); the SFU reading media (SFrame keyed
from the MLS exporter; an SFU-admitted client without keys sees only ciphertext — E2E tested);
injected or unencrypted frames (dropped before decoding); a removed member listening on (new
epoch, new keys, dropped from the call); TURN as a path into our network (deny-list tested
against real coturn); TURN credential theft (10-minute HMAC credentials with no identity in the
username); IP exposure to the other person (relay unless their safety number is verified; each
device enforces it for itself); downgrade to unencrypted group calls (refused without
encoded-frame support). Residual: the server and SFU learn who calls whom, when, for how long and
from which devices; the SFU sees the audio-level header extension (who speaks) and VP8 frame
headers (key frames, sizes, resolution); TURN sees users' IP addresses; the fingerprint check is
as strong as the MLS authentication of the caller's device (unverified safety numbers mean
trust-on-first-use).

**Phase 10 delta (notifications).** New flows: Web Push from the API to third-party push
services and on to browsers; a service worker that decrypts on the device; security alerts.
Analysis in [phase-reports/phase-10.md](phase-reports/phase-10.md) and ADR-048. Mitigated:
content leaving the server in notifications (payloads name only the conversation, are padded to
one size and encrypted to the browser — E2E tested by decrypting real pushes); push services
linking people through a shared conversation (per-subscription topics); SSRF through
user-supplied push endpoints (https:443 allow-list, pinned public addresses, no redirects —
mutation-tested); pushes to signed-out sessions, revoked devices or removed members (checked
before every push); two contexts corrupting a device's MLS state (Web Lock plus a writer fence in
the local store — unit and E2E tested; this also closes a latent two-tab risk); notification
floods (coalescing and a minimum interval). Residual: push services see that and when a device
is woken; the server knows notification preferences, mutes and quiet hours; what a notification
shows on the lock screen is the person's choice (default: nothing but "New message"); browsers other than
Chromium are not covered by automated push tests.
