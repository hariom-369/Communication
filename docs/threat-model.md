# Threat model

Status: **refreshed in Phase 16** (§7: what of each mitigation is built) — re-reviewed at the end
of every phase and by the external security reviewer before public beta. Method: asset/actor analysis + STRIDE per trust boundary, then
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

**Phase 11 delta (moderation and safety).** New flows: reports carrying reporter-selected
plaintext sealed to a moderation key; message franking commitments and server tags on every
message; a moderation console with evidence views; automated restrictions; public grievance
form; staff roles. Analysis in [phase-reports/phase-11.md](phase-reports/phase-11.md) and
ADR-049. Mitigated: fabricated reports of encrypted messages (franking: the server verifies the
reported plaintext is what the sender's device sent — integration- and E2E-tested; tampering
yields "unverified", mutation-checked); moderators browsing conversations (no such route; evidence
only through its case, every view recorded and audited — tested); a single moderator banning or
referring someone (second reviewer with step-up — tested); suspended accounts continuing to act
(sessions revoked, server-side route gate — mutation-checked); harassment after blocking
(server-enforced on every path, including typing); report floods and brigading (per-person
limits, distinct-reporter counting, automated effect limited to a 24 h new-chat restriction plus
human review); fresh-account spam waves (first-week limits); phishing links (blocklist in public
content; private-chat warnings without revealing the link to the server). Residual: the HPKE
private key can open every reported bundle (KMS custody in production; only reported content);
the server learns who reported whom and when, and who blocked whom; a reporter chooses what to
include (selection bias); exact hashing misses altered media; coordinated reporting can impose a
24 h restriction on a target; staff roles are granted by database operators until the admin
console (Phase 12); old messages without franking stay unverifiable.

**Phase 12 delta (admin plane).** New: a separate admin process and origin; staff identities
signing in through the corporate identity provider and a hardware security key; RBAC with
just-in-time elevation; four-eyes approvals; purpose-bound account views; feature flags that
switch features off; an operator command. Analysis in
[phase-reports/phase-12.md](phase-reports/phase-12.md) and ADR-050. Mitigated (TB6, T-05):
admin account takeover (identity provider plus physical key; synced passkeys refused; optional
model allow-list proven by vendor attestation; token replaced after the key step; 30-minute
idle limit — tested); phishing (WebAuthn origin binding: a key answer for another origin is
refused — tested); OIDC code or token injection (PKCE, state, nonce, issuer, audience and expiry
checks; single-use flow — each tested against a misbehaving provider); identity confusion
(issuer and subject bound at first sign-in; same email from another subject refused — tested);
privilege escalation by one person (time-bound roles, elevation only by eligibility plus another
admin's approval, self-approval refused in code and by the database, the role's subject cannot
approve, atomic claim — tested and mutation-checked); insider browsing (exact lookup with a
purpose that must fit both viewer and person; bulk-lookup alert; every look audited with its
purpose — tested); unaudited actions (audit write before the response; refusals audited;
authorization before body parsing — tested by the route × role matrix, mutation-checked);
cross-plane confusion (admin cookie meaningless to the user API and vice versa; separate origin
allow-lists — tested); singling people out through analytics (counts below 5 suppressed —
tested). Residual: a super admin pair can do anything the console allows (two-person collusion);
admins see account metadata within their role and purpose; without an allow-list the
"single-device" property is the authenticator's claim; vendor certificate revocation (FIDO MDS)
is not consulted; off-hours and repeated-view alerting rules are pending (Phase 16); network
reachability through the access proxy only is a deployment control (Phase 15).

**Phase 13 delta (billing).** New: payment providers as a trust boundary (TB8), signed webhooks
that change what accounts may do, hosted checkout, invoices with buyer names and GSTINs. Analysis
in [phase-reports/phase-13.md](phase-reports/phase-13.md) and ADR-051. Mitigated: card-data
exposure (hosted checkout; no card or UPI data stored — SAQ-A); forged webhooks granting plans
(HMAC-SHA256 per provider, constant time, Stripe timestamp tolerance, Razorpay event id —
tested, mutation-checked); replays and duplicate deliveries (event id inserted with its effect —
tested, including six concurrent copies); out-of-order or stale deliveries rolling state back
(provider state fetched under a per-subscription lock — tested); CSRF on the new
cookie-less endpoints (no session is read; the exemption is limited to the `webhook` kind);
stand-in URLs or test keys reaching production (config refuses them — tested); entitlements
outliving payment (exact `valid_until`, 7-day grace from the first failure — tested); paying
twice (second subscription ended, refund alert); a person reading another's invoice (owner-only,
404 — tested). Residual: the provider is trusted for payment state (an attacker with the
provider dashboard or API key can grant plans); webhook endpoints are public (rate-limited per
address, cheap rejection before any database work); invoices hold buyer names, states and
GSTINs for the statutory period; refunds and disputes are handled in provider dashboards.

**Phase 14 delta (web code delivery, PWA).** New: a service worker that serves the app from its
own verified copy, a release signing key, an installable app, route chunks loaded on demand.
Analysis in [phase-reports/phase-14.md](phase-reports/phase-14.md) and ADR-052. Mitigated:
tampered, partially deployed or mixed-up asset files and CDN/storage tampering for returning
browsers (every file checked against the signed manifest at install; a changed file on the server
is not used — tested, mutation-checked); rollback to an older release (refused — unit-tested);
an update signed by an unknown key, even one the new worker embeds (refused; the trusted release
keeps running and the page says an update was refused — tested); unaudited releases (signed
manifest per release, `verify-release` monitor — tested); a failed install leaving partial copies
(per-install cache removed — mutation-checked); the worker caching or answering API, realtime or
media requests (pass-through by path and origin — unit-tested). Residual (stated in e2ee.md §7):
the first visit trusts the server; whoever can serve `sw.js` and holds the signing key can ship
any code; theft of the signing key lets an attacker sign releases until rotation, and its loss
without an announced successor strands browsers on the last release; no public transparency log
or reproducible builds yet; lazily loaded chunks have no SRI on a first visit (the pin covers
them afterwards); the pinned copy keeps the CSP captured at install until the next release.

**Phase 15 delta (load testing; availability).** No new trust boundary or data flow: the load
harness runs only against a disposable local stack and seeds its own database. Analysis in
[phase-reports/phase-15.md](phase-reports/phase-15.md) and [capacity.md](capacity.md). T-18
(DDoS) and self-inflicted overload, now measured: a deploy spreads reconnects over a 30 s drain
window; a **listen backlog of 4096** stops dropped SYNs during bursts; a full survivor pod refuses
upgrades (503) rather than degrading every socket, so the realtime tier is sized N+1; quadratic
group fan-out (members² receipt frames, then members² row reads per message, which an ordinary
1,024-member group could trigger by chatting) is gone (integration-tested, mutation-checked); an
API process no longer exits when a background job cannot get a database connection (unit-tested).
A realtime pod **crash** still degrades connected users' sends for ≈ 20 s while its clients
reconnect: cluster-wide ticket admission (`REALTIME_TICKETS_PER_SECOND`) did not prevent that
and is off by default; refused tickets carry a spread `Retry-After` that the client now honours.
Residual: reconnect throughput is an availability limit (API headroom and pod size are the
mitigation, deployment.md); if admission is enabled it is cluster-wide, so a flood of valid
sessions requesting tickets slows everyone's reconnects (each account is still held to 60 tickets
a minute, and each address to the unauthenticated flood guard), and its counter fails open if
Valkey is down; an unauthenticated per-address socket cap belongs at the
edge (WAF/load balancer, Phase 17); capacity figures come from one machine and are re-measured in
staging.

## 7. Status as built (Phase 16 refresh, Phase 17 delta)

The register (§4) lists the intended mitigations. This is what exists in the code after
Phase 16, what is a deployment property (Phase 17), and what is still to build — checked during
the internal review ([security/review.md](security/review.md), findings F-nn). Phase 17 added the
supply-chain controls of T-17/T-19/T-20, isolated the link-preview fetcher (T-18/SSRF, F-05) and
fixed live delivery after a Valkey loss (availability, F-15); "deployment property" items are
written as Terraform and manifests but not yet applied to a real account (deployment.md).

| ID | Built and tested | Deployment property (Phase 17) | Not built yet |
|---|---|---|---|
| T-01 | rate limits, new-account limits, blocks, reports with franking, privacy controls | — | — |
| T-02 | `__Host-` HttpOnly cookie, CSP + Trusted Types, session list and revoke, new-login alerts; adding any factor (passkey, TOTP, recovery codes) needs a recent re-authentication, so a stolen session cannot make itself permanent (F-11) | — | short idle timeout on shared devices (user setting) |
| T-03 | device revoke, MLS removal, disappearing messages | — | ASK rotation UX ("Start over" only) |
| T-04 | E2EE, ASK-signed device certificates, client-enforced group policy, signed commits, fingerprint-substitution refused (E2E) | — | key transparency (S-07, post-GA) |
| T-05 | admin RBAC, step-up, four-eyes, purpose binding, every admin call audited | break-glass production access | — |
| T-06 | Argon2id + pepper, hashed session tokens, ciphertext only | encryption at rest, KMS-held keys | canary records |
| T-07 | client-encrypted blobs and backups, random keys, opaque downloads (F-03) | Block Public Access, bucket policies, access logs (infra/terraform, Phase 17) | — |
| T-08 | E2EE independent of TLS, DTLS fingerprints via MLS | TLS 1.3, HSTS preload, CT monitoring | — |
| T-09 | passkeys first, no SMS factor, login alerts | lookalike-domain monitoring | — |
| T-10 | breached-password check (F-04, Phase 16), rate limits, passkeys, TOTP | breached-password mirror | MFA prompts on risk, credential-stuffing detection (F-09) |
| T-11 | link confirmation with step-up, notices to own devices and contacts | — | — |
| T-12 | no phone factor or phone-only recovery | — | — |
| T-13 | — (out of our control) | — | desktop app |
| T-14 | React escaping, no HTML rendering, strict CSP + Trusted Types, crypto in a worker, XSS payloads in every rendered field (F-10) | user-content origin for document viewers | — |
| T-15 | Origin allow-list, single-use tickets from a CSRF-protected endpoint | — | — |
| T-16 | new-account limits, behaviour signals, email verification | — | risk-based sign-up friction (F-09), graph-based detection |
| T-17 | signed release manifest, SW pinning, no rollback; signed images verified at deploy (Phase 17) | release key custody (ops/runbooks/release-signing-key.md), 2-person release approval (protected environment) | reproducible builds, transparency log (F-06) |
| T-18 | per-route limits, flood guard, ticket admission option, N+1 realtime sizing, backlog 4096, no super-linear regex on user input (F-12) | CDN/WAF/Shield, autoscaling, edge socket caps | — |
| T-19 | pinned actions, least-privilege CI tokens, secret scan; SBOMs, image scan, keyless signing, BuildKit provenance, signature check before deploy, checksum-pinned release tools (Phase 17, F-06) | protected branches, OIDC credentials, cluster admission policy (bootstrap) | SLSA Build L3 |
| T-20 | lockfiles, dependency review, install-script allow-list, OSV for npm and Cargo (F-02), `cargo deny` licences/bans/sources (Phase 17), Dependabot for npm, Cargo, actions, images and Terraform | — | — |
| T-21 | ciphertext padding, no content in push, retention limits | restricted internal access | sealed sender (S-09, research) |
| T-22 | encrypted local store, device lock (PIN/passkey), remote revoke | — | — |
| T-23 | client-side backup encryption, 256-bit keys, alerts | — | backup rollback detection (S-06) |
| T-24 | MLS generation guard, message id dedupe, idempotent sends | — | — |
| T-25 | Rust parsing, length limits, fuzz targets run nightly in CI (`fuzz.yml`); ids in decrypted content and server frames validated before they key client state (F-13) | — | — |
| T-26 | ASK-signed certificates verified by clients | — | — |
| T-27 | claim rate limits, last-resort KeyPackage | claim-rate alerts | — |
| T-28 | E2EE limits what can be produced; legal-order workflow | — | — |

New in this refresh: **T-29 — security documents claiming controls the code lacks.** Found
twice in Phase 16 (a SQL lint rule, a breached-password check — F-01, F-04). Mitigation: claims
are checked against code in each review; generated documents where possible (the route matrix
and OpenAPI document are produced from the code and checked for drift in CI).

