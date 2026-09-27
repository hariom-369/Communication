# Cryptographic design

Status: NEEDS-SECURITY-REVIEW (S-01..S-06) · This document specifies **how we use** MLS and
established primitives. It specifies no new cryptographic protocol. Any change to this file
requires review by the designated cryptography reviewer (CODEOWNERS).

## 1. Components

| Component | Implementation | Notes |
|---|---|---|
| Group key agreement, ratcheting, message protection | **OpenMLS** (RFC 9420), pinned version | via `packages/crypto-core` (Rust) |
| MLS crypto provider | `openmls_rust_crypto` (RustCrypto) or `openmls_libcrux_crypto` (formally verified libcrux) — **reviewer to choose (S-01)** | libcrux preferred where it covers the suite |
| Signatures (ASK, device certs) | Ed25519 (`ed25519-dalek`, strict verification) | same library family as MLS provider |
| Blob encryption (media, backups) | libsodium `crypto_secretstream_xchacha20poly1305` (`libsodium-sys`/`dryoc` — pick one audited binding) | chunked AEAD with rekey/final tags |
| Key wrapping | HPKE (RFC 9180) base mode for device-to-device; AES-256-GCM-SIV or XChaCha20-Poly1305 for local wrapping | |
| Hashing / KDF | SHA-256, HKDF-SHA-256, BLAKE2b (libsodium) | |
| Password-derived keys (not used for backups at launch) | Argon2id | |
| Randomness | OS/Browser CSPRNG via `getrandom` | never `Math.random` |

**Rules:** no primitive is implemented in TypeScript; TypeScript code never handles raw key
bytes except opaque handles; all crypto in Rust with `zeroize` on secret types; constant-time
comparisons via `subtle`.

## 2. Ciphersuites

- `0x0001` MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 — baseline, mandatory to implement.
- `0x004D` MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519 (X-Wing hybrid; no IANA code
  point yet) — **target default at GA if S-02 approves**.
- ML-KEM/ML-DSA suites from `draft-ietf-mls-pq-ciphersuites` — tracked, not enabled.

Every KeyPackage and group records its suite. A group's suite is chosen as the best suite
supported by *all* invited devices; migration to a new suite = create a successor group and
link it via a signed `ReInit` (RFC 9420 §12.1.5) — never silent downgrade. Clients refuse
to create a group below the configured minimum suite.

## 3. Identities and credentials

### 3.1 Account Signing Key (ASK)
- Ed25519 keypair generated on the user's first device in the crypto worker.
- Public key uploaded; server stores it with a version number.
- Private key: stored encrypted in the device's local store on **trusted devices** and in
  the encrypted backup (BRK-protected).

### 3.2 Device certificate (our own data structure, signed with standard Ed25519)
```
DeviceCertificate v1 (Protobuf, deterministic encoding; signature over
                      "tessera-device-cert-v1" || encoded_body)
  user_id            bytes(16)
  device_id          bytes(16)
  mls_signature_key  bytes(32)      # device's MLS leaf signature public key
  ask_version        uint32
  created_at         uint64 (unix seconds)
  capabilities       repeated uint32 (ciphersuites, extensions)
  signature          bytes(64)      # Ed25519 by ASK
```
- MLS credential type: `BasicCredential` whose identity = `user_id || device_id`; the
  certificate is carried in a leaf-node extension and **validated by every client** on
  Add/Update/Welcome (OpenMLS credential validation hook). A leaf without a valid
  certificate chaining to the member's pinned ASK is rejected and the group is flagged.
- Future: X.509 or MLS `x509` credentials if we add enterprise identity.

### 3.3 Device revocation
User signs `DeviceRevocation{device_id, ask_version, at}` with the ASK. Server removes the
device from routing; every group containing the device receives a Remove commit (issued by
any other device of the user, or by any member on seeing a valid revocation). Clients refuse
messages from revoked devices after the revocation's epoch.

## 4. KeyPackages (MLS analogue of prekeys)

- Each device keeps **100 one-time KeyPackages** per supported suite on the server,
  replenishing when fewer than 25 remain, plus **one last-resort KeyPackage** rotated every
  7 days (RFC 9420 `last_resort` extension).
- Lifetime extension: 30 days. Server deletes expired packages.
- Claim is atomic (`FOR UPDATE SKIP LOCKED`) and rate-limited per claimer (anti-exhaustion);
  when only the last-resort remains, the server returns it (not consumed).
- **Exhaustion attack** (attacker drains one-time packages): bounded by per-account claim
  limits (e.g. 50 claims/hour per claimer, 500/day per target), and falling back to the
  last-resort package keeps delivery working with slightly weaker FS for the first epoch.

## 5. Delivery Service rules (server, RFC 9750 roles)

1. Accept a Commit for epoch `e` only if group epoch == `e`; otherwise `409 EPOCH_CONFLICT`.
2. Commits and Proposals must be `PublicMessage`; server verifies the MLS signature
   against the sender leaf's known signature key (from device certificate) and validates
   **policy** (sender role permits Add/Remove) — defence in depth; clients re-check.
3. Application messages must be `PrivateMessage`; server checks only framing, epoch,
   size ≤ 64 KiB, and sender device membership (from authenticated session).
4. Welcome messages are stored per target device and deleted on fetch-ack.
5. Server never generates, modifies or reorders content of MLS messages.

## 6. Ratcheting, FS and PCS schedule

- Within an epoch, each sender's messages use the MLS secret tree (hash ratchet); keys are
  deleted after use. Out-of-order window: `max_past_epochs = 2`, `out_of_order_tolerance =
  200`, `maximum_forward_distance = 1000` generations (limits memory DoS).
- Each device issues an **Update commit** (self-update with path) when: 7 days since its
  last update, or 100 messages sent since last update, or a device is removed from the
  user's account, or the client detects a possible compromise signal (e.g., restored from
  backup on new hardware).
- Old epoch secrets are deleted after `max_past_epochs`.
- Disappearing messages: the timer is an E2EE group-context extension; clients delete
  plaintext at expiry; server deletes ciphertext at `expires_at`.

## 7. Replay, duplicates, ordering

- MLS rejects reused generations per sender within an epoch (OpenMLS reuse guard).
- Every application message payload includes a 128-bit `message_id` (UUIDv7) inside the
  encrypted Protobuf; clients dedupe on it. Server dedupes on `(sender_device, client_msg_id)`.
- Displayed order = server `seq` (total order per conversation); client timestamp is
  informational only.

## 8. Safety numbers

For users U and V with ASK public keys `K_U`, `K_V` and user IDs `id_U`, `id_V`:

```
fp(id, K) = 30-byte output of Signal's published numeric-fingerprint construction
            (iterated SHA-512 over version || K || id, re-hashing with K each round,
             5200 iterations), with our own version constant so values never collide
             with Signal's
digits(fp) = six 5-digit groups: each 5-byte chunk as big-endian uint40 mod 100000
safety_number = sort_lexicographic(digits(fp(id_U,K_U)), digits(fp(id_V,K_V))) joined → 60 digits
QR payload = version(1) || fp(id_U,K_U) || fp(id_V,K_V)
```

This mirrors the construction of Signal's published numeric fingerprint (iteration count,
chunking) applied to our ASK instead of a per-device identity key. **Reviewer to confirm
equivalence and parameters (S-04).**

## 9. Plaintext payload schema (inside MLS application message)

```
Envelope v1 (Protobuf)
  message_id        bytes(16)
  sent_at_ms        uint64       # sender clock, informational
  oneof body {
    Text            { text, mentions[], reply_to }
    Media           { blob_id, key(32), secretstream_header(24), ciphertext_sha256,
                      plaintext_sha256, size, mime, thumbnail(Media), duration_ms, width, height }
    Reaction        { target_message_id, emoji, remove }
    Edit            { target_message_id, new_text }
    Delete          { target_message_id }
    ReadReceipt     { up_to_seq }
    Typing          { state }                    # sent via realtime ephemeral path, still MLS-encrypted
    Poll / PollVote
    CallSignal      { call_id, sdp | ice | hangup, dtls_fingerprint }
    GroupMetaUpdate { name, description, avatar(Media) }
    HistoryTransferOffer, FrankingTag (if ADR-021 adopted)
  }
  padding           bytes        # pad plaintext to bucket sizes (32, 64, 128 … 64 KiB) to reduce length leakage
```

Unknown fields are ignored (forward-compatible); unknown `body` variants render as
"update the app to view this message".

## 10. Local key storage (web)

- IndexedDB database `tessera-crypto`; every record `AES-256-GCM(key=LSK, nonce=random96, aad=record_type||record_id)`.
- LSK = non-extractable WebCrypto `CryptoKey`, generated on device registration, stored in
  IndexedDB (structured-clone of CryptoKey). Clearing site data = device loss (warned).
- OpenMLS storage provider implemented over this store; writes are transactional per
  processed message (state is committed only after the message is durably stored locally —
  prevents ratchet desync on crash).

## 11. Parsing hardening

- All inbound bytes (MLS messages, certificates, envelopes) parsed in Rust with length
  limits before allocation; fuzzed continuously (`cargo-fuzz`) in CI nightly.
- Malformed input returns a typed error; never panics across the WASM boundary
  (`panic = "abort"` is not used in WASM; we catch and surface errors).

## 12. What requires expert review before implementation proceeds past Phase 4

S-01 protocol/implementation choice and crypto provider; S-02 PQ suite; S-03 web key
storage & code delivery; S-04 ASK/cross-signing & safety numbers; S-05 media construction;
S-06 backup construction; S-10 franking. See [review-register.md](review-register.md).
