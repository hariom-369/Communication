# Phase 6 report — End-to-end encrypted media

**Status: GREEN locally — NOT releasable to users.** Verified 2026-10-02. CI has not run, because
the branch still cannot be pushed (GitHub returns 403 for the Claude app).

Like Phases 4 and 5, this needs the external cryptography review before real users rely on it:
S-05 (media construction and metadata). The design and every deviation are in ADR-043.

Chats now carry photos, videos, voice messages and files. Each attachment is encrypted on the
sender's device under its own key. It is uploaded straight to object storage as ciphertext, and
the recipient's device checks it before decrypting. The key and every detail about the file
(name, type, size, preview) travel only inside the encrypted message.

## Results

| Gate | Result |
|---|---|
| Format, lint (TS strict + security rules; `rustfmt`, `clippy -D warnings` native and wasm32), typecheck, build (Rust → WASM → web) | pass |
| Unit tests | **297 TypeScript** (api 147, web 63, ui 59, platform 15, shared 7, realtime 3, validation 3) + **63 Rust** |
| Integration (real PostgreSQL + Valkey + S3-compatible store) | **112**: api 97, realtime 15 |
| End-to-end (Chromium, production build under strict CSP + Trusted Types, real services) | **24 passed in each of the last 6 consecutive full runs**, after the selector fix (see the defects below) |
| Fuzzing | new `media` target ~2.0 M runs, **no crashes** |
| Mutation checks | Rust digest checks (hashes, sizes) 2/2 caught; server media controls 6/6 caught, after one test was strengthened |
| OpenAPI | 62 paths (5 new) |
| `pnpm audit` / gitleaks (history) | no known vulnerabilities / no leaks |

## Delivered

**Crypto core (`packages/crypto-core/src/media.rs`)**

- **Per-attachment encryption:**
  - A fresh random 256-bit key for each attachment.
  - XChaCha20-Poly1305 in the STREAM construction (64 KiB chunks), under an HKDF-SHA-256 subkey.
  - This is the same reviewed construction as backups (ADR-042), not a new one.
- **Hash checks:** SHA-256 of both ciphertext and plaintext is computed while encrypting. On
  decrypt, both hashes and both sizes are checked in constant time before any plaintext is
  returned.
- **Incremental API:** encryption and decryption work chunk by chunk, so 200 MiB files are never
  held twice in memory.
- **WebAssembly classes:** `MediaEncryptor` and `MediaDecryptor`. Keys come from the provider's
  CSPRNG.

**API (`services/api`)**

- **Migration `0006_media`:**
  - `media_blobs`: random object keys, upload state, expiry.
  - `media_links`: blob ↔ conversation, with the referencing message's expiry.
- **Object storage:** an S3 client, `platform/object-store.ts` (AWS SDK v3, pinned).
- **Uploads:**
  - Presigned multipart uploads: 8 MiB parts, 15-minute URLs, `Content-Length` signed.
  - Fresh URLs can be requested for long or resumed uploads.
  - Completion checks the part list and the stored size.
  - Uploads can be cancelled.
- **Attaching to messages:** `messaging.send` accepts `attachments`. Only the sender's own
  finished uploads can be attached, in the same transaction as the message.
- **Downloads:** a 5-minute presigned GET. Allowed for the uploader, or a current member of a
  conversation the blob was sent to, while that message has not expired. Anyone else gets the
  same 404 as for a blob that doesn't exist.
- **Limits:**
  - 200 MiB per attachment (photos 25 MiB).
  - 10 uploads in progress.
  - 300 uploads and 2 GiB per day per account.
- **Sweeper:** deletes expired objects and rows, and aborts abandoned uploads.
- **Configuration:**
  - `MEDIA_S3_*`. Production rejects static keys and non-https endpoints.
  - MinIO is in the local compose file. Tests use the moto emulator (`TEST_S3_URL`, pinned).

**Web (`apps/web`)**

- **Crypto worker:**
  - Encrypts and decrypts in 1 MiB slices, outside the MLS call queue.
  - Caches downloaded ciphertext (≤ 256 MiB); the key stays in the encrypted history.
- **Composer:**
  - Attach files (multiple, or drag and drop), with a caption.
  - Voice messages via MediaRecorder (Opus), with a recording timer and cancel.
- **Preparation on the device:**
  - Photos (JPEG, PNG, WebP) are re-encoded, which removes EXIF and GPS, and capped at 4096 px.
  - A ≤ 320 px preview goes inside the message.
  - Videos get a poster frame; voice messages get a waveform.
  - File names are sanitised: paths, control characters and bidi overrides are removed.
- **Sending:** an upload progress bar with Cancel. A failed upload can be retried.
- **Display:**
  - Inline rendering is limited to an allow-list of image, video and audio types.
  - Everything else, including HTML and SVG, is a download (`application/octet-stream`).
  - Types that can run code carry a warning.
  - Expired attachments and ones that fail verification show explanations.
- **Chat list:** the preview names the attachment type ("📷 Photo · caption").
- **Headers:**
  - CSP: `img-src`/`media-src` gain `blob:`, and `connect-src` gains the storage origin.
  - `Permissions-Policy: microphone=(self)`.

## Defects found and fixed during this phase

- **A crafted MIME type could make an attachment an HTML document in our origin.** The sender
  chooses the declared type, and the first version opened full-size images in a new tab from a
  `blob:` URL. A message claiming `category: image, mime: text/html` would therefore have opened a
  same-origin HTML document. Found in self-review before any test existed. Fixed in two ways:
  - Inline display uses a type allow-list; everything else is downloaded as octet-stream.
  - The new-tab link is replaced by in-place zoom.
- **Our app violated its own CSP, and the test meant to catch it missed it.** Zod 4 probes for JIT
  support with `new Function` at startup. Our CSP and Trusted Types blocked it, and Zod fell back
  safely, but it is still a violation. The E2E tracker's regex didn't match Chromium's wording
  ("TrustedScript"). Found while investigating the next item. Fixed in two ways:
  - Zod is configured `jitless` before any schema is created.
  - The tracker now matches every Trusted Types wording and `unsafe-eval`.
  - This had been present since the strict CSP was introduced.
- **The password-reset E2E test failed intermittently (4 of 12 full runs).** The cause was in the
  test, not the app. The trace's DOM snapshot during the `fill` shows the targeted input is the
  login page's "Email or username" field: the URL had already changed to `/forgot-password`, but
  React Router had not yet committed the new page. `getByLabel('Email')` is a substring match, so
  it typed into the outgoing form; the new form then rendered empty, and its `required` field
  blocked the submit.
  - **Fix:** the test waits for the new page's heading and matches labels exactly.
  - **Process:** the first hypothesis (two `/login` navigations on sign-out, which are real but
    harmless) was tested and **did not** fix it (1 failure in the next 6 runs). The redundant
    navigation was still removed as a cleanup.
- **The integration suite silently ran no API tests.** Turbo didn't pass `TEST_S3_URL` through to
  tasks, and CI would have hit the same problem. Fixed in `turbo.json`.
- **Voice messages showed as files.** MediaRecorder's `audio/webm;codecs=opus` failed the MIME
  check. The container type is now used.
- **A mutation survived: the part-order check.** It was shadowed by the store's own validation. A
  test now asserts storage is never asked to assemble a bad part list.
- **Smaller issues:**
  - A slow deep-equal over megabyte arrays in a test.
  - A name clash with `sha2::Digest`.
  - Two React hook lint findings.

## Security implications reviewed

Threat-model delta (docs/threat-model.md, media.md §3/§7):

- **What the server can do to attachments:**
  - It can withhold or delete them.
  - It cannot read them: it holds ciphertext only.
  - It cannot swap them undetected: the message carries the hashes, checked in constant time.
  - It cannot truncate or reorder them: STREAM's final-chunk flag.
  - It cannot enumerate them: object keys are random 128-bit values and every download needs
    authorization.
- **What the server learns:** ciphertext size, uploader, which conversation, and upload/download
  times. This is documented in privacy.md. Names, types, dimensions, previews and keys stay
  inside the encrypted message.
- **Stolen download URL:** usable for 5 minutes and yields only ciphertext.
- **Malicious sender:**
  - Cannot get HTML or SVG rendered: the type allow-list, octet-stream downloads, and a CSP
    without `unsafe-eval`.
  - Cannot spoof file names with bidi tricks: names are sanitised.
  - Cannot point recipients at another user's blob: attaching requires ownership, and the digest
    must match.
- **Malware sent privately cannot be detected by Tessera.** This is stated honestly in
  media.md §3; dangerous types are flagged.
- **Abuse limits:** per-account volume and in-progress limits, and route rate limits.
- **Test store limitation:** the moto test store does not verify signatures, so URL expiry and
  signed lengths are asserted on the URL, plus the size re-check at completion. **A real S3 or
  MinIO run is required before a shared environment.**
- **Logs** carry blob counts from the sweeper only. They never carry keys, URLs, names or content.

## Explicitly not done (moved, with reason)

- **Public and channel media pipeline** (malware scanning, sandboxed transcoding, CSAM hash
  matching, polyglot and decompression-bomb checks) → Phase 8. The first public content arrives
  then.
- **Document viewers** on a separate user-content origin → Phase 14. Documents are downloads.
- **Deferred to before public beta:**
  - Resuming uploads across a reload.
  - Forwarding without re-upload.
  - Media bytes in backups (backups already carry the keys).
  - A server-side ciphertext checksum (S3 checksums).
- **Location sharing and contact cards** → with the features that need them (Phase 7+).
- **Image recompression for GIF/HEIC.** These are sent as files.

## Next

Phase 7 — groups and communities (S-12). The S-05 review package is ready
(docs/review-register.md).
