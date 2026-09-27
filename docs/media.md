# Media architecture

Status: NEEDS-SECURITY-REVIEW (S-05) · Decision: ADR-013

## 1. Types and limits (FREE tier; higher tiers via entitlements)

| Type | Max size | Client processing before encryption |
|---|---|---|
| Image (JPEG, PNG, WebP, HEIC→JPEG, GIF) | 25 MiB | EXIF/GPS stripped by re-encoding (canvas/OffscreenCanvas); thumbnail 320px |
| Video (MP4/H.264, WebM) | 200 MiB | Poster frame thumbnail; no transcoding in browser at launch |
| Audio / voice message (Opus in WebM/Ogg) | 50 MiB | Waveform preview computed client-side |
| Documents (PDF, Office, text, archives) | 200 MiB | Filename + type recorded in E2EE message only |
| Contact card | inline (≤ 8 KiB) | — |
| Location | inline | Static map preview rendered **client-side** from tiles fetched via a privacy proxy (P1) |

## 2. E2EE media upload flow

```
Client (crypto worker)                       api/media                     S3 (bucket: e2ee-media)
 1. key = random 32 B; header,stream = secretstream_init(key)
 2. encrypt in 64 KiB chunks (last chunk TAG_FINAL); compute ciphertext SHA-256 incrementally
 3. POST /api/v1/media/uploads {size, scope:"e2ee", parts} ──▶ checks entitlement quota, rate limit
                                                              creates blob row + S3 multipart upload
                                                   ◀── {blob_id, part URLs (presigned PUT, 15-min expiry,
                                                        Content-Length bound)}
 4. PUT parts (parallel ×4, resumable: failed parts retried; session resumable 24 h) ──────▶
 5. POST /media/uploads/{id}/complete {parts ETags, ciphertext_sha256}
                                                              S3 CompleteMultipartUpload; verify size;
                                                              blob.status=ready; expires_at = +30 days
 6. send MLS message Media{blob_id, key, header, hashes, size, mime, thumbnail…}
Recipient: GET /media/{blob_id}/download → authz (member of a conversation referencing blob?)*
           → 302 presigned GET (5-min expiry) → download → verify ciphertext hash → decrypt stream
           → verify plaintext hash → render (in sandboxed viewer, never as HTML in app origin)
```

\* The server does not know which conversation references a blob (reference is inside
ciphertext). Authorization model: **capability + membership hint** — the sender attaches
`blob_id` to the submit request metadata (`attachments: [blob_id]`) so the server records
`blob ↔ conversation`; downloads require membership of a linked conversation. This leaks
"message N has an attachment of size S" to the server (already inferable from upload
timing); documented in [privacy.md](privacy.md).

- Blob lifetime for E2EE media: 30 days (aligned with mailbox retention); recipients store
  decrypted media locally (encrypted IndexedDB/OPFS) and in backups.
- Forwarding: re-uses the same blob + key (no re-upload) while unexpired; server sees a
  new blob↔conversation link.

## 3. Malware and abuse controls under E2EE

The server cannot scan E2EE blobs. Controls:
- Client-side: magic-byte sniffing vs claimed MIME; dangerous types (`.exe`, `.apk`,
  `.js`, `.html`, `.svg`, macro-enabled Office) shown with a warning and never auto-opened;
  SVG/HTML never rendered inline; PDFs rendered with a sandboxed PDF.js in a
  `sandbox` iframe on the user-content origin.
- Server-side: per-account upload rate/volume limits; hash-based blocklists only on
  **reported** content (reporter provides plaintext) and public content.
- Honest limitation: Tessera cannot detect malware sent privately between users. Documented.

## 4. Public / channel / community-large-room media

```
upload (presigned, bucket: public-ingest) → media worker:
  1. size/type verification (magic bytes, libmagic), reject polyglots
  2. malware scan (ClamAV + commercial engine at scale)
  3. CSAM hash matching (e.g. PhotoDNA/industry hash lists — licensing L-12)
  4. transcode (ffmpeg in sandboxed, no-network, seccomp-restricted job pods, CPU/time limits)
  5. strip metadata; generate thumbnails/renditions
  6. store in public-media bucket → CloudFront (signed URLs for private channels)
```

Image/video processing libraries are a major attack surface (malicious files). Workers run
as non-root, read-only root FS, no network egress, with per-job resource limits, and are
patched on a weekly cadence.

## 5. Buckets

| Bucket | Content | Encryption | Public access | Lifecycle |
|---|---|---|---|---|
| e2ee-media | client ciphertext | SSE-KMS (defence in depth) | blocked | delete after 30 days |
| public-ingest | untrusted uploads | SSE-KMS | blocked | delete after 24 h |
| public-media | processed public media | SSE-KMS | via CloudFront OAC only | per content |
| backups-user | client-encrypted backups | SSE-KMS | blocked | versioned; keep last 3 + 7-day noncurrent |
| exports | user data exports | SSE-KMS + per-export key | blocked | delete after 7 days |

Presigned URLs: content-length-range enforced, short expiry, bound to exact key; CORS
allows only our web origin. Object keys are random (`blob_id`), never user-supplied names.

## 6. Tests (Phase 6 exit)

Tampered ciphertext / truncated stream rejected; wrong key; hash mismatch; oversized part;
presigned URL reuse after expiry; download without membership; polyglot/zip-bomb/
decompression-bomb on public path; EXIF stripped; resumable upload after network drop;
transcoder sandbox has no network.
