# Encrypted backups

Status: NEEDS-SECURITY-REVIEW (S-06) · Decision: ADR-014

## 1. Goals

- Backups are encrypted on the device before upload; Tessera and its storage providers
  never receive plaintext or the key.
- User-controlled recovery; device migration; versioning; integrity verification.

## 2. Contents of a backup

Local message database (decrypted history), media (optional, size-capped by tier), ASK
private key, contact ASK pins and verification states, self-sync state, settings.
**Not included:** MLS group state (not portable safely — restored devices re-join groups as
new devices), LSK, session cookies.

## 3. Keys

```
BRK  (Backup Root Key, 32 random bytes, generated once per account backup setup)
 ├── BEK_v = HKDF(BRK, salt=backup_id, info="tessera-backup-enc-v1")   → secretstream key per backup version
 ├── BMK   = HKDF(BRK, info="tessera-backup-manifest-v1")              → manifest MAC key
 └── wrapped copies stored on server (opaque blobs):
      W_rk  = AEAD(key = HKDF(RecoveryKey, info="tessera-rk-wrap-v1"), BRK)
      W_pk  = AEAD(key = HKDF(passkey PRF output(salt_i), info="tessera-pk-wrap-v1"), BRK)   (0..n passkeys)
```

- **Recovery key**: 32 random bytes shown as 52-char base32 groups plus a QR; user must
  confirm by re-typing 3 random groups. The server never sees it.
- **Passkey-assisted recovery**: WebAuthn PRF extension (`hmac-secret`) evaluated with a
  per-wrap salt. Works only with authenticators that support PRF and — for recovery on a
  new device — only if the passkey is synced (platform passkey managers) or a roaming
  security key is present. Clearly labelled "may not work on every device; keep your recovery key".
- **Password-only**: not offered (ADR-014) until an HSM-backed, attempt-limited vault exists.

## 4. Format and integrity

```
backup object (S3, versioned):  header{format=1, backup_id, created_at, ciphersuite} ||
                                secretstream ciphertext of a tar-like stream (records)
manifest: {backup_id, version, prev_backup_hash, ciphertext_sha256, size, created_at}
          + MAC_BMK(manifest)
```

- Retain the last 3 versions per user (configurable), older deleted by lifecycle rule.
- Restore verifies: manifest MAC, ciphertext hash, secretstream final tag (truncation), and
  `prev_backup_hash` chain (detects server rollback to an older backup, surfaced as a warning).
- Upload via multipart presigned URLs; resumable; backups run in the background when the
  app is open (browsers cannot run scheduled background jobs reliably — PWA limitation).

## 5. The recovery vs zero-knowledge trade-off

| If the user… | Outcome |
|---|---|
| Keeps any trusted device | Nothing lost |
| Loses all devices, has recovery key or working passkey | Full restore of backed-up history |
| Loses all devices and all backup credentials | **Messages are unrecoverable. Tessera cannot help.** Account can still be recovered (email/2FA/recovery codes) but with a new ASK; contacts see a key change |

Account recovery (login) and message recovery (keys) are **deliberately separate**.
Support staff have no tool that can restore messages — by design. Product copy and the
onboarding flow must state this in plain language.

## 6. Device migration

Preferred: link new device from old (multi-device §3) with history transfer. Fallback:
restore from backup. Both produce a new device identity; the old device can then be revoked.

## 7. Threats specific to backups

| Threat | Mitigation |
|---|---|
| Storage leak | Ciphertext only; 256-bit keys; no password-derived keys |
| Server swaps/rolls back backup | MAC + hash chain; warning on rollback |
| Attacker with account access deletes backups | S3 versioning + 7-day soft-delete; security alert email on backup deletion/re-key |
| Attacker adds own passkey wrap | Adding a wrap requires BRK (only on the user's devices) + re-auth; alert on new wrap |
| Recovery key photographed | Out of scope; user guidance |
