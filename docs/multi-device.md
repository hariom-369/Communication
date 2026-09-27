# Multi-device architecture

Status: NEEDS-SECURITY-REVIEW (S-04) · Decisions: ADR-007, 008, 010

## 1. Model

- A user has 1..N devices (launch limit: **8 devices** per user; configurable by tier).
- **No primary device.** Any device can send, receive, add groups, and — if *trusted* —
  link or revoke other devices. The phone is not the source of truth (contrast with early
  WhatsApp Web).
- Each device: own MLS signature key, own KeyPackages, own leaf in every conversation.
- Trust between a user's devices is anchored in the **Account Signing Key** (ASK).

```
User (ASK)
 ├─ Device A  trusted   (holds ASK)
 ├─ Device B  trusted   (holds ASK)
 └─ Device C  untrusted (no ASK; cannot link/revoke; can message) — e.g. a shared computer
```

## 2. First device (account creation)

1. User authenticates (Phase 2 flows) → session with no device.
2. Crypto worker generates ASK, device MLS signature key, LSK, 100 KeyPackages.
3. Worker signs `DeviceCertificate`; client `POST /api/v1/devices` with ASK public key,
   certificate, KeyPackages. Server binds session → device.
4. Client prompts backup setup (recovery key / passkey) — strongly encouraged,
   skippable, with persistent reminder; without it, losing all devices loses history
   and requires an **ASK reset** (contacts see a key-change warning).

## 3. Linking a new device (QR, preferred)

```
New device (N)                        Server                        Existing trusted device (E)
 1. authenticate (password/passkey+2FA) → "pending device" session (cannot read/send)
 2. generate device keys; show QR:
    {link_id, N_hpke_public, N_sig_public, fingerprint}   ← ephemeral HPKE key
                                                         3. user scans QR on E
                                                         4. E shows "Link 'Chrome on Windows'?
                                                            located near Pune (approx.)"; user confirms
                                                         5. E signs DeviceCertificate(N) with ASK
                                                         6. E HPKE-encrypts to N_hpke_public:
                                                            {cert, ASK private key (if "trusted"),
                                                             contact ASK pins + verification states,
                                                             conversation list, optional history bundle key}
 7. ◀──────────── encrypted link payload relayed by server (server cannot read) ─────────────
 8. N verifies cert, stores state, uploads KeyPackages; server activates device
 9. E issues Add commits adding N to each conversation (batched, rate-limited);
    Welcome messages delivered to N
10. All contacts' clients see "Asha added a new device" (non-blocking notice)
```

- Binding the QR to the pending session: `link_id` is single-use, expires in 3 minutes,
  and the server requires that the relayed payload targets the same pending session.
- **Anti-phishing:** E displays the new device's platform, approximate location, and link
  time; the QR cannot be used from a remote attacker's machine without the user physically
  scanning the attacker's QR — this is the classic QR-login phishing risk ("scan this code
  to verify"), mitigated by explicit wording and by showing location/device info (T-11 in
  [threat-model.md](threat-model.md)).

## 4. Linking without an existing device (recovery)

- Via **encrypted backup**: user supplies recovery key or passkey (PRF) → BRK → backup
  contains ASK → new device self-signs its certificate → joins conversations by asking
  other members' devices to Add it (members' clients auto-accept adds of devices with a
  valid ASK-signed certificate), or via MLS **external commit** where group policy allows.
- **Without backup/recovery key**: ASK reset. New ASK generated; version increments;
  all contacts get a key-change warning; old conversations are not recoverable.
  This is the honest trade-off of zero-knowledge E2EE (see [encrypted-backups.md](encrypted-backups.md) §5).

## 5. History for new devices

MLS forward secrecy means a newly added device **cannot** decrypt messages sent before it
joined. History options:

| Method | How | Limits |
|---|---|---|
| Device-to-device transfer | E exports selected history, encrypts with a fresh key (secretstream), uploads as blob, sends key inside the HPKE link payload | E must be online during linking; size cap by tier |
| Backup restore | Restore latest encrypted backup | Backup freshness |
| None | Start fresh | Default for untrusted devices |

## 6. Consistency across a user's devices

Things that must sync between one user's own devices, and how:

| State | Mechanism |
|---|---|
| Messages in conversations | MLS (all devices are members) |
| Own sent messages | Same group → own other devices receive them |
| Read state, archived/pinned chats, drafts, mute | **Self-sync conversation**: an MLS group containing only the user's own devices; sync events are E2EE |
| Contact ASK pins / verification states | Self-sync conversation |
| Privacy settings, notification prefs | Server (not secret; enforced server-side) |
| Blocked users | Server (needed for enforcement) |

## 7. Device revocation

1. From any trusted device (or the account security page after re-auth + 2FA), user revokes device D.
2. Trusted device signs `DeviceRevocation(D)`; server: revokes D's sessions and push
   subscriptions immediately, deletes D's unclaimed KeyPackages, stops routing to D.
3. Remove commits for D in every conversation (by the revoking device; other members'
   clients also issue removes if they observe a valid revocation and D is still present
   after 1 hour).
4. All remaining devices of the user perform an Update (PCS).
5. If D held the ASK and compromise is suspected, UI offers **ASK rotation**: new ASK,
   re-certify remaining devices, contacts see key change.

"Log out all devices" = revoke every device except the current one + all sessions.

## 8. Server-side session ↔ device binding

- Session cookie authenticates the *account*; every device-scoped API call additionally
  proves device possession: requests include `X-Device-Id` and an Ed25519 signature by the
  device MLS signature key over `(method, path, body_sha256, timestamp, session_id_hash)` for
  sensitive endpoints (KeyPackage publish, device ops, commits). Prevents a stolen cookie
  alone from impersonating a device for key operations (T-02).
- Realtime connections are bound to `(session, device)`.

## 9. Tests required (Phase 5 exit)

Link/revoke under concurrency; linking while offline members; ghost-device injection by a
malicious server fixture (must be rejected); ASK rotation; history transfer integrity;
self-sync convergence; revocation removes from all groups; 8-device limit.
