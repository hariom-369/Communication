# Phase 4 report — End-to-end encryption foundation

**Status: GREEN locally — NOT releasable to users.** Verified 2026-09-28. CI has not run, because
the branch still cannot be pushed (GitHub returns 403 for the Claude app).

The external cryptography review (S-01..S-04) must sign off before any real user relies on
this. The review package is ready; the review itself has not been contracted yet.

Chats are now end-to-end encrypted with MLS (RFC 9420) in every build. The server stores and
relays only ciphertext. Decrypted history lives on the device, encrypted at rest. The Phase 3
development plaintext mode is gone.

## Results

| Gate | Result |
|---|---|
| Format, lint (TS strict + security rules; `rustfmt`, `clippy -D warnings` native and wasm32), typecheck, build (Rust → WASM → web) | pass |
| Unit tests | **261 TypeScript** (api 130, ui 59, web 44, platform 15, shared 7, realtime 3, validation 3) + **38 Rust** |
| Integration (real PostgreSQL + Valkey) | **96**: api 81, realtime 15 |
| End-to-end (Chromium, production build under strict CSP + Trusted Types, real services) | **18 passed, 3 consecutive full runs** |
| Fuzzing (cargo-fuzz, 45 s each locally; 30 min nightly in CI) | certificate ~10.3 M runs, padding ~16.1 M, snapshot ~7.7 M, inbound MLS ~22 k — **no crashes** |
| Mutation checks | Rust trust checks 9/9 caught; server key controls 8/8 caught; both race fixes have tests that fail without the fix |
| OpenAPI | 46 paths (9 new) |
| `pnpm audit` / gitleaks (history) | no known vulnerabilities / no leaks (see the gitleaks note below) |

## Delivered

**Crypto core (`packages/crypto-core`, Rust → WebAssembly)**

This is orchestration only. OpenMLS 0.9 with the RustCrypto provider does all protocol
cryptography, and `ed25519-dalek` handles certificates.

- **Identity:** an Account Signing Key per user, and a device certificate binding each device's
  MLS signature key to that key. Certificates use a fixed binary layout and a domain-separated
  Ed25519 signature with strict verification (ADR-039).
- **Trust checks:** every member is validated against the *pinned* identity key.
  - Checks: the credential must be `user‖device`; the certificate must name exactly that device
    and leaf signature key; the key version must match; the signature must verify; the user must
    be a conversation member.
  - Where they apply: KeyPackages, Welcome trees, Add/Update proposals, and the committer's new
    leaf.
  - An untrusted Welcome leaves no state behind.
- **Identity pinning:** trust-on-first-use pins. A changed identity key un-verifies the contact
  and is surfaced to the user. A different server value for our own key is refused.
- **Group operations:**
  - KeyPackages: one-time and last-resort, 30-day lifetime.
  - Creating a group and joining one.
  - Membership changes and self-updates for post-compromise security (7 days or 100 messages).
- **Messages:**
  - Padding hides lengths (64 B–56 KiB buckets).
  - Replay, wrong-epoch and tamper handling come back as typed errors.
- **Safety numbers:** Signal's published numeric-fingerprint construction applied to the
  identity key. Checked against an independent Python implementation.
- **Persistence:** full state snapshot and restore for encrypted persistence.

**Web (`apps/web`)**

- **Dedicated crypto worker:** the main thread never holds keys or MLS state. It is started
  through a single Trusted Types policy that only allows same-origin worker scripts. The CSP adds
  `'wasm-unsafe-eval'`, not `unsafe-eval`.
- **Encrypted local store** (IndexedDB):
  - AES-256-GCM under a non-extractable WebCrypto key.
  - Additional authenticated data binds each record to its position.
  - MLS state, history and cursor are written in one transaction.
  - The ratchet state is persisted **before** any ciphertext leaves the worker, so a crash cannot
    cause ratchet-generation (nonce) reuse.
  - If the WASM instance traps, it is reloaded from the last persisted state.
- **E2EE session:**
  - Automatic setup of the first device.
  - Group creation, with the server's epoch compare-and-set deciding which device's creation
    wins.
  - Welcome handling and membership sync with the key directory.
  - KeyPackage top-up.
  - Key-change detection, re-checked on every load.
- **UI:**
  - A "Set up encryption on this device" / "signed out of encrypted chats" screen, with an
    identity reset protected by step-up (ADR-040).
  - Safety-number comparison with "Mark as verified" and a Verified badge.
  - A blocking key-change notice that holds outgoing messages until the user continues, and
    survives reloads.
  - Notices when a contact has not set up encryption yet, while waiting for a Welcome, and when a
    security check failed.
  - "Couldn't be decrypted" placeholders.

**API (`services/api`)**

- **`keys` module:**
  - Register the first device; reset the identity (step-up, audited, revokes all devices,
    notifies contacts).
  - Own keys and contacts' keys; contacts can read them, others get 404.
  - KeyPackage upload, count and atomic claim (`FOR UPDATE SKIP LOCKED`, last-resort fallback,
    anti-exhaustion limits per claimer and per target).
  - Device certificates are verified server-side as defence in depth. The parser is tested
    against the Rust output.
- **Messaging:**
  - MLS commits with epoch compare-and-set (409 on conflict).
  - Welcomes per target device (list and acknowledge), with membership and device checks.
  - Sender-device attribution and `kind` on mailbox messages.
  - The development ciphersuite is removed; migration 0004 deletes any leftover plaintext-mode
    conversations and adds a constraint.
- **Realtime events:** `welcome` and `keys_changed`.
- **Robustness:** pool idle errors are handled in every service.

**CI**
- The Rust toolchain is pinned (`rust-toolchain.toml`).
- A crypto-core lint step and `cargo test` run inside `pnpm test`.
- A nightly fuzz workflow runs 4 targets for 30 minutes each.
- The development bundle check was removed, since that build no longer exists.

## Defects found and fixed during this phase

1. **Trusted Types blocked the crypto worker.** `new Worker(url)` needs a TrustedScriptURL under
   `trusted-types 'none'`. The fix adds exactly one narrow policy, `tessera-worker`
   (same-origin only), instead of relaxing Trusted Types.
2. **Losing the group-creation race could strand a device.** Found by a flaky E2E test and
   reproduced about 1 run in 6 with instrumented logs.
   - A device checked "is my group unconfirmed?" and later discarded it.
   - Between those two worker calls, the Welcome handler's `join` replaced that group with the
     real one, so the discard deleted the real group.
   - Fix: an atomic `abandonUnconfirmed` in the worker. In addition, a foreign creating commit
     arriving on an unconfirmed group now yields to the Welcome instead of being recorded as a
     failed commit, which had raised a false security alarm.
   - After the fix: 12/12 targeted repetitions and 3/3 full-suite runs pass. Regression tests
     fail without the fix.
3. **False "couldn't be decrypted" message** for the group creator, from the echo of its own
   already-merged commit.
   - Found by reviewing screenshots; the E2E tests had not asserted on it.
   - Fix: own commit echoes are reported as `own`, and placeholders are shown for application
     messages only. The E2E tests now assert that no such placeholder appears in normal chats.
4. **Security state was not restored after a reload.** Verification badges disappeared on
   reload, and so would an unacknowledged key-change warning. Every conversation's identities
   are now re-checked on load, and an E2E test reloads before continuing.
5. **Test gaps found by mutation testing** (Rust): removing the certificate-to-signature-key
   binding check, or the certificate identity check, was not caught. Tests with server-forged
   KeyPackages were added and both mutations are now caught.
6. **Wrong error mapping.** An expired-epoch message was reported as "duplicate". It now maps to
   `WRONG_EPOCH`.
7. **A removed device could not process its own removal.** It is now handled without
   validating the new leaves, since the device drops the group anyway.
8. **UUID version mismatch.** Device IDs were UUIDv4; they are now UUIDv7 per ADR-028, as the API
   requires.
9. **Timing test too sensitive to CPU contention.** An existing constant-work test for password
   hashing used single samples, so parallel Rust tests could skew it. It now uses interleaved
   medians.

## Security implications reviewed

**Properties delivered, each with a test:**
- the server never sees plaintext (E2E test on raw database rows);
- the server cannot add a device that clients accept (forged KeyPackage and forged commit tests);
- replays and tampering are rejected;
- sender relabelling by the server is detected (`SENDER_MISMATCH`);
- history survives the server deleting its copy;
- keys at rest are encrypted under a non-exportable key;
- no nonce reuse after a crash.

**New attack surface:**
- 7 key-directory endpoints and 3 messaging endpoints;
- the WASM worker;
- IndexedDB.

**Residual risks and open items** (tracked in [crypto-design.md §0](../crypto-design.md), ADR-039..041):
- **Unreviewed.** Nothing here is reviewed yet (S-01..S-04). No user-facing release before
  sign-off.
- **Trust on first use.** Users who never compare safety numbers trust the server's first answer
  for a contact's key. Key transparency (S-07) is post-GA.
- **Web code delivery** (e2ee.md §7): a compromised server could serve malicious JavaScript.
  Signed-manifest pinning is Phase 14 (S-03).
- **Server-side checks deferred.** The server does not yet verify commit signatures (clients
  do), and the last-resort KeyPackage is not rotated weekly yet.
- **One device per account.** An identity reset loses access from other devices and does not
  transfer history. Device linking comes in Phase 5.
- **Bundle size.** The WASM module is 2.3 MB uncompressed; size budgets are Phase 14.

**Note on the secret scanner.** A plain filesystem scan (`gitleaks dir`) reports test PEM
fixtures compiled into dependency metadata under the git-ignored `target/` directories. None of
it is ever committed. The repository scan (`gitleaks git`, as in CI) is clean. `.gitleaks.toml`
only exempts `Cargo.lock`, whose crate names (e.g. `libcrux-secrets`) trip a generic rule.

## Next

Phase 5, multi-device:
- device linking by QR with the existing identity;
- history transfer;
- per-device revocation;
- encrypted backups (S-06).

In parallel, contracting the S-01..S-04 cryptography review is the critical-path item.
