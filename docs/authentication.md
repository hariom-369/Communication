# Authentication architecture

Status: PROPOSED (phone flows NEEDS-LEGAL-REVIEW L-02/L-03) · Decisions: ADR-015, 030 ·
Standards: OWASP ASVS 5.0 (V6 Authentication, V7 Session Management — target L3),
NIST SP 800-63B, WebAuthn Level 3

## 1. Identifiers

| Identifier | Role | Uniqueness | Notes |
|---|---|---|---|
| `user_id` (UUIDv7) | Internal key | global | never shown |
| Username | Public handle, discovery | case-insensitive unique; 5–32 chars `[a-z0-9_]`, confusable-skeleton check (Unicode TR39) | can change (30-day cool-down; old name reserved 14 days) |
| Email | Login, recovery, security alerts | unique, verified | required at launch |
| Phone (E.164) | Optional login/recovery/discovery | unique, verified | subject to L-02/L-03 (SIM binding, MNV) |

Login accepts email, username or phone + a credential. Error messages never reveal whether
an identifier exists (uniform response + timing equalisation).

## 2. Credentials

### 2.1 Passwords
- Argon2id, PHC string, parameters from OWASP Password Storage Cheat Sheet minimums
  **raised after benchmark**: start `m=64 MiB, t=3, p=1` (target ≤ 250 ms on API pods);
  params stored per hash; rehash on login when params change.
- Hashing runs in a worker-thread pool (bounded concurrency) — prevents event-loop blocking
  and hash-flooding DoS; login endpoint rate limits apply *before* hashing.
- Policy (NIST 800-63B): min 12 chars, max 128, all Unicode (NFKC-normalised), no
  composition rules, blocklist of breached passwords (k-anonymity range query against a
  locally mirrored breached-password corpus, not a live third-party call), no periodic rotation.
- Pepper: HMAC-SHA-256 with a KMS-held key applied before Argon2id (defence if DB leaks
  without KMS access). Pepper rotation via versioned prefix.

### 2.2 Passkeys (WebAuthn)
- Library: SimpleWebAuthn (server + browser) — maintained, spec-tracking.
- RP ID = registrable domain; `userVerification: "required"`; `residentKey: "preferred"`;
  attestation `none` (consumer product).
- Challenges: 32 random bytes, stored in Valkey with 5-min TTL, single use, bound to session/flow.
- Verify: origin, RP ID hash, UV flag, signature, sign-count regression → flag (not hard fail;
  synced passkeys report 0). Record BE/BS flags.
- Passkey-only accounts permitted (no password). A passkey satisfies MFA (phishing-resistant AAL2+).
- PRF extension requested at registration for backup wrapping ([encrypted-backups.md](encrypted-backups.md)).

### 2.3 Second factor
- TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step), secret encrypted with KMS envelope;
  replay prevention (last used step stored).
- Passkey as second factor for password logins.
- **SMS OTP is not offered as a 2FA factor** (SIM-swap risk); SMS/email OTP only for
  verification and low-assurance recovery steps combined with other factors.
- Recovery codes: 10 × 10-char base32, shown once, stored as SHA-256 (high entropy → fast
  hash acceptable), single-use; regeneration invalidates old set.

## 3. Flows

### Sign-up
1. Email (+ username, optional phone) → Turnstile/hCaptcha-style challenge where risk requires.
2. Email verification link/code (6-digit, 10-min TTL, 5 attempts, hashed at rest).
3. Choose passkey (recommended) or password; offer TOTP.
4. Age declaration + ToS/Privacy notice acceptance (DPDP notice, consent records) — 18+ gate (L-06).
5. First device registration ([multi-device.md §2](multi-device.md)).

### Login
`identifier → risk evaluation → primary factor → (MFA if enrolled or risk-required) →
session created (new ID) → device selection/linking`.

### Password reset
Email link (token 256-bit, hashed, 30-min TTL, single use) → if MFA enrolled, MFA required
→ set new password → **all other sessions revoked** → security alert to all channels.
Password reset never touches E2EE keys (they are not derived from the password).

### Account recovery (lost MFA)
Recovery code → login. No recovery code: identity proofing workflow (email + phone
possession + 7-day waiting period with notifications to all contact points; the user can
cancel from any existing session). Support agents cannot bypass MFA; every recovery is audited.

## 4. Sessions (ADR-015)

| Property | Value |
|---|---|
| Token | 256-bit CSPRNG, base64url; stored as SHA-256 |
| Cookie | `__Host-tsid; Secure; HttpOnly; SameSite=Lax; Path=/` (no Domain) |
| Idle timeout | 30 days (web), policy-configurable (e.g. 6 h if DoT web-session rule applies — L-02) |
| Absolute lifetime | 90 days → re-authenticate |
| Rotation | new session ID on login, MFA step-up, privilege change; old ID revoked |
| Step-up | sensitive ops (change email/password/MFA, link/revoke device, export, delete account, backup key ops) require auth within last 10 min |
| Revocation | per session, per device, all; propagated to realtime within 1 s |
| Binding | device-scoped ops also require device signature ([multi-device.md §8](multi-device.md)) |

Session fixation impossible: IDs are only ever issued by the server after authentication.
Tokens never in `localStorage`, URLs, or logs.

## 5. CSRF

- `SameSite=Lax` + all state-changing endpoints require header `X-Tessera-CSRF: 1`
  (forces CORS preflight; cross-origin forms can't set it) + `Origin` must match allow-list
  + Fetch Metadata: reject `Sec-Fetch-Site: cross-site` on non-GET.
- CORS: API allows only the web origin, credentials true, explicit methods/headers.

## 6. Suspicious login detection

Signals: new device/browser fingerprint (coarse UA family), new ASN/country, impossible
travel, Tor/VPN/hosting-provider ASN, credential-stuffing patterns (many identifiers per
IP), failed MFA bursts. Risk score → actions: allow / require MFA / require email
confirmation / block + notify. Every new login sends an alert (email + in-app on other
devices) with "This wasn't me" → revoke + reset flow.

## 7. Rate limits (initial)

Implemented values (Phase 2; all fail closed if Valkey is unavailable):

| Endpoint | Limits |
|---|---|
| Any request | 1,200/min per IP (flood guard, CGNAT-tolerant) |
| Login (password) | 5/min and 20/h per identifier; 30/min per IP. Soft, time-based lock — never permanent (avoids lockout-DoS) |
| MFA step | 5 per 5 min per half-authenticated session; 10/h per user |
| Email verification | 5 attempts per code; 10/h per email; 30/h per IP |
| Sign-up / resend | 5/h per email; 30/h and 10/h per IP respectively (risk-based challenges: Phase 11) |
| Password reset request | 3/h per email; 10/h per IP; uniform response |
| Step-up re-authentication | 10 per 15 min per user |
| Credential changes (authenticated) | 20/h per user |
| WebAuthn options | 20/min per IP |

## 8. Admin authentication

Separate IdP (SSO via OIDC with enforced WebAuthn/hardware keys), no passwords in our DB for
admins, short sessions (8 h absolute, 30 min idle), device posture via ZTNA. See [admin.md](admin.md).

## 9. Tests (Phase 2 exit)

Credential stuffing simulation; lockout DoS resistance; timing uniformity for unknown
identifiers; session fixation; cookie flags; CSRF matrix (cross-site form, fetch without
header, wrong Origin); step-up enforcement; password-reset revokes sessions; TOTP replay;
WebAuthn origin mismatch; recovery code single-use; Argon2 parameter upgrade path.
