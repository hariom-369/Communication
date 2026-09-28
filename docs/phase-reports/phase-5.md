# Phase 5 report — Multi-device end-to-end encryption

**Status: GREEN locally — NOT releasable to users.** Verified 2026-09-28. CI has not run, because
the branch still cannot be pushed (GitHub returns 403 for the Claude app).

Like Phase 4, this needs the external cryptography review before real users rely on it:
S-04 (device linking, device trust) and S-06 (backups). The design and every deviation are in
ADR-042.

An account can now use encrypted chats on up to 8 devices. You link a device by typing a code
shown on it, and you can move your history across. Encrypted backups can be unlocked with a
recovery key or a passkey. Search runs only over the history stored on the device.

## Results

| Gate | Result |
|---|---|
| Format, lint (TS strict + security rules; `rustfmt`, `clippy -D warnings` native and wasm32), typecheck, build (Rust → WASM → web) | pass |
| Unit tests | **281 TypeScript** (api 142, ui 59, web 52, platform 15, shared 7, realtime 3, validation 3) + **57 Rust** |
| Integration (real PostgreSQL + Valkey) | **105**: api 90, realtime 15 |
| End-to-end (Chromium, production build under strict CSP + Trusted Types, real services) | **21 passed, 3 consecutive full runs** |
| Fuzzing | new `backup` target (wrap, backup body, manifest, recovery-key parsing) ~3.3 M runs; `inbound` extended to link payloads and backup restore — **no crashes** |
| Mutation checks | Rust linking/backup trust checks 8/8 caught; server controls 10/10 caught; web backup-ownership guard caught |
| OpenAPI | 57 paths (11 new) |
| `pnpm audit` / gitleaks (history) | no known vulnerabilities / no leaks |

## Delivered

**Crypto core (`packages/crypto-core`)**

This is orchestration of established constructions only. There is no new primitive or protocol.

- **Link codes (`link.rs`):** 24 base32 characters. They combine the server-assigned 5-byte
  link id with an 80-bit truncated SHA-256 fingerprint over the new device's HPKE and signature
  keys, with domain separation and length prefixes. The code is compared in constant time.
- **Link payload:** sealed with HPKE (RFC 9180, the MLS provider's implementation). The AAD binds
  it to the link id and the new device id.
- **What each side checks:**
  - The approving device refuses keys that don't match the code.
  - The new device checks the payload's certificate: user, device, signature key, identity-key
    version and signature.
  - It checks that the identity key in the payload is the account's current key as the directory
    lists it, and that the secret matches it.
- **Messages-only devices:** they get a certificate but not the identity key or backup key. They
  cannot approve links or make backups.
- **Backups (`backup.rs`):**
  - A random backup root key, wrapped with XChaCha20-Poly1305 under an HKDF of the recovery key
    or of a passkey PRF output.
  - The body is encrypted with the STREAM construction in 64 KiB chunks.
  - The manifest is authenticated with HMAC-SHA-256.
  - The restore order: unwrap → manifest MAC → ciphertext hash → decrypt → the identity must be
    the account's current one → the device certifies itself.
  - `backup_owns` stops a device holding a stale backup key from overwriting the account's
    backups.
- **Recovery key:** 52 base32 characters in groups of four. It accepts lower case and spacing,
  and rejects non-zero padding bits.
- **New devices of contacts:** tracked per contact, so the UI can say "added a new device".

**API (`services/api`)**

- **Migration `0005_multi_device`:**
  - Device labels and a trusted flag.
  - `link_sessions`: single use, 3-minute expiry, at most 3 waiting per account.
  - `backups`: at most 32 MiB each, last 3 versions kept.
  - `backup_wraps`: at most one recovery-key wrap and any number of passkey wraps.
- **Linking:**
  - Creating a link is rate-limited.
  - Lookup only works within the same account.
  - Approval needs step-up re-authentication and an active device of the account.
  - The payload is delivered once, only to the session that asked.
- **Adding a device:**
  - The certificate must verify under the *current* identity key.
  - The 8-device limit is enforced.
  - It is audited, triggers `keys_changed` for contacts and the owner, and sends a security email.
- **Removing a device:** needs step-up and is audited and emailed. A removed device id can never
  be registered again.
- **Backups:**
  - An upload needs an unlock method to exist.
  - The version is compare-and-set.
  - Adding or removing unlock methods and turning backups off need step-up, are audited and
    trigger emails.
  - The status shows the latest manifest and MAC, so devices can check ownership without
    downloading the backup.

**Web (`apps/web`)**

- **Encryption setup** (shown when this device has no keys) offers three choices:
  - Link from another device: shows a code with an expiry countdown and polls for approval.
  - Restore from backup: with the recovery key or a passkey.
  - Start over: identity reset, with its consequences spelled out.
  - A removed device can delete its local data and be set up again.
- **Settings → Devices** (new page):
  - The device list: full access or messages only, when added and last active, and Remove.
  - Link a new device: enter the code → see the device name → choose full access and history
    transfer → approve.
  - Backups: turn on, where the recovery key is shown once with a "saved it" confirmation; back up
    now; a new recovery key; unlock with a passkey; remove a passkey; turn off and delete.
  - Automatic daily backup while the app is open.
- **Passkeys** are registered with the PRF extension. PRF evaluation uses a local random
  challenge; the output stays in the browser.
- **Search:** over decrypted history on the device only. It ignores case and accents. Nothing is
  sent to the server.
- **After setup:** messaging starts by itself once the device is linked or restored.
- **Local store:** IndexedDB connections close on `versionchange`, so deleting local data is
  never blocked by another tab.

## Defects found and fixed during this phase

- **Wrong codes were caught too late.** A mistyped or substituted link code was only rejected at
  approval, after the approval screen had already shown the device. It is now checked as soon as
  the code is entered (`verifyLinkCode`), and checked again at approval. Found by E2E.
- **Deleting local data could hang.** It waited forever while another connection (another tab,
  or a stale engine) held the database open. Found by an engine test; fixed with
  `onversionchange`.
- **Two backup keys could exist at once.** A device holding an older key could upload backups
  that the current recovery key cannot open. This happens when backups are turned off and on
  again from another device. Such a device now refuses to upload (`backupOwns`).
- **A device could be half set up.** If linking or restoring finished but registering the device
  did not, the device was left in that state. It now completes on the next start. The server
  refuses reuse of a removed device id, so this cannot undo a removal.
- **The E2E suite hit a real limit.** The suite now signs up more than 30 accounts from one IP,
  which exceeds the per-IP sign-up and email-verification limits. The test harness resets those
  two counters before the multi-device spec. The limits themselves stay covered by integration
  tests, and the IP cannot be spoofed through the proxy.
- **Smaller issues:** Rust `KeyInit` trait ambiguity; the STREAM encryptor was moved inside a
  loop; rate limits were too tight for legitimate retries (link creation is now 20/h with burst
  10); a test that only looked like it caught a mutation (a borrow error) was fixed and re-run.

## Security implications reviewed

Threat-model delta (docs/threat-model.md T-02, T-11 and the backup threats):

- **Ghost device injected by the server.** Blocked. A device joins groups only with a
  certificate from the pinned identity key. The link payload is authenticated by the code the
  user types, and the expected identity key comes from the directory and is checked against the
  secret.
- **Server substitutes the new device's keys.** It would need a second preimage of an 80-bit
  truncated SHA-256, within the 3-minute lifetime of a single-use link.
- **Phishing ("type this code").** An attacker who already has the password and 2FA shows a code
  and persuades the victim to approve it. Mitigations:
  - Approval needs step-up re-authentication.
  - The device name is shown, with explicit copy: "Only continue if it is your device and you
    are holding it now."
  - Every new device triggers a security email and a contact-visible notice.
  - The device can be removed.
- **Stolen session cookie.** It cannot approve a link, add or remove backup unlock methods, turn
  off backups or remove a device without step-up. Session↔device possession signatures are
  deferred.
- **Removed device that had full access.** It still holds the identity key; the UI says so, and
  "Start over" rotates it. ASK rotation that keeps the other devices is deferred.
- **Backups.** The server holds ciphertext, MACs and 72-byte wraps. There is no password-derived
  key. Tampering and forgery are detected. **Rollback to an older authentic version is not yet
  detected** (`prev_hash` is not filled in).
- **Logs** carry no link codes, recovery keys, PRF outputs, sealed payloads or backup contents.
  They record only ids, sizes and actions.

## Explicitly not done (moved, with reason)

- **Self-sync group** for read state and settings → Phase 7, which builds the group machinery.
- **QR scanning** for link codes → with camera-capable clients. The typed code carries the same
  fingerprint.
- **Deferred to before public beta:**
  - Signed per-device revocation.
  - ASK rotation that keeps the other devices.
  - Session↔device proof-of-possession.
  - Backup rollback detection.
- **Backups:** object storage and media → Phase 6. The recovery key is confirmed with a checkbox
  instead of re-typing groups.
- **Location on the approval screen** → needs an IP-geolocation source with a privacy review.

## Next

Phase 6 — media: client-side encrypted attachments (S-05). S-04 and S-06 review packages are
ready (docs/review-register.md).
