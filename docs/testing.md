# Testing strategy

Status: PROPOSED · Testing is part of the Definition of Done for every feature.

## 1. Test pyramid and tools

| Layer | Scope | Tools | Runs |
|---|---|---|---|
| Unit | pure functions, policies, validators, reducers | Vitest; Rust `cargo test` + proptest | every PR |
| Crypto | crypto-core API, MLS flows, test vectors, fuzzing | Rust tests, RFC 9420 test vectors (via OpenMLS), `cargo-fuzz`, wasm-bindgen-test in headless Chromium/Firefox | PR (fuzz: nightly 1 h per target) |
| Integration | module + real Postgres/Valkey/MinIO | Vitest + Testcontainers | every PR |
| API / contract | every route: auth, authz, validation, rate limit, error contract | generated route test matrix; OpenAPI schema conformance (Schemathesis-style fuzzing) | every PR |
| WebSocket | handshake, ticket, origin, frames, backpressure, reconnect | Vitest + `ws` client harness | every PR |
| E2E | browser flows across multiple virtual users/devices | Playwright (Chromium, Firefox, WebKit), multi-context | PR (smoke), nightly (full) |
| Security (DAST) | running staging | OWASP ZAP baseline + authenticated scan; custom attack suites | nightly |
| Load | capacity, soak | k6 (HTTP + WS), headless crypto clients | pre-release, Phase 15 |
| Failure / chaos | dependency loss, pod kills, network partitions | Toxiproxy, chaos experiments in staging | weekly |
| Migration | up on empty + production-shaped fixture; lint for locking ops | squawk, custom harness | every PR touching migrations |
| Accessibility | WCAG 2.2 AA | axe-core in Playwright, manual screen-reader passes | PR + release |
| Visual | design-system components | Playwright screenshots | PR |

## 2. Required suites (from the brief) and where they live

| Suite | Examples of mandatory cases |
|---|---|
| Authentication | signup/verify/login/logout; passkey register/login; TOTP; recovery codes single-use; reset revokes sessions |
| Authorization | permission matrix per module; IDOR on every ID param; role escalation attempts; admin purpose-binding |
| E2EE | 1:1 and group send/receive; tampered ciphertext rejected; wrong epoch; replayed message; forged sender; malicious-server fixture adding ghost device → rejected; commit violating E2EE policy → rejected |
| Device sync | link, revoke, history transfer, self-sync convergence, concurrent linking, 8-device cap |
| Group encryption | concurrent commits (409 path), add/remove storms, 1,024-member timing, re-key on removal (removed device can't decrypt next epoch) |
| Media | encryption/decryption, truncation, hash mismatch, resumable upload, unauthorized download, public-path malicious files |
| Abuse / rate limit | per-key limits, bypass via IP rotation / IPv6 /64 / multiple devices, new-account throttles |
| Failure recovery | DB failover mid-send (idempotent retry → exactly one message), Valkey loss degraded mode, realtime pod kill → reconnect + resync, S3 outage |
| Migration | forward-compat with previous app version (expand/contract) |
| Calls | fingerprint substitution by a malicious server → call fails; SFU-side frames are SFrame ciphertext (no nonce reuse; unencrypted frames not played); re-key on removal; unsupported browser refused; TURN deny-list against real coturn; ICE restart after the relay is replaced; RFC 9605 test vectors; opt-in 32-participant load (`TESSERA_LOAD_TESTS=1`, `e2e/calls-load.spec.ts`) |

The end-to-end suite starts real call infrastructure (`e2e/global-setup.ts`): coturn
(`turnserver`, from the system package) with `infra/calls/turnserver.conf` plus loopback peers
allowed, and a LiveKit server (`livekit-server`, `~/.local/bin` or `LIVEKIT_SERVER_BIN`; CI
builds the pinned Go module). Chromium runs with synthetic camera and microphone and with the
permission prompts and screen picker answered automatically.

## 3. Security test catalogue (mandatory)

| Attack | Test |
|---|---|
| Authentication bypass | every non-public route called without session → 401; with revoked/expired session → 401 |
| Authorization bypass | cross-user/object access matrix; admin routes from user sessions |
| CSRF | cross-site form POST; fetch without CSRF header; wrong Origin; `Sec-Fetch-Site: cross-site` |
| XSS | payload corpus in every user-controlled string field rendered in UI (names, messages, captions, file names) → no script execution (Playwright asserts no dialog/CSP violation) |
| Injection | SQLi/NoSQLi/command/header injection corpus against validators & queries |
| SSRF | link-preview fetcher: private IPs, DNS rebinding, redirects to metadata IP, IPv6-mapped, decimal/octal IP encodings |
| WebSocket hijacking | connection from disallowed Origin; reused ticket; ticket from another session; no ticket |
| Session fixation | pre-set cookie ignored; ID rotates on login |
| Session theft | cookie flags; device-signature required for key ops with stolen cookie only |
| Brute force | login/OTP/recovery endpoints lockout & rate limits; timing uniformity |
| Rate-limit bypass | parallel requests (race), header spoofing (`X-Forwarded-For` not trusted beyond edge) |
| Replay | re-submitted identical frames/requests (idempotent), replayed MLS messages rejected |
| Duplicate messages | retry storms produce exactly one mailbox row |
| Malicious files | EICAR on public path; zip bomb; polyglot; oversized; MIME mismatch |
| Oversized requests | body limits per route; WS frame > limit → close 1009 |
| Malformed envelopes | fuzzed MLS/Protobuf into server and crypto-core → typed errors, no crash |
| Device impersonation | device-scoped call with another device's ID; unsigned request; wrong signature |
| Prototype pollution | `__proto__`/`constructor` payloads → 400 |

## 4. Structural enforcement

- **Route completeness test**: iterates the route registry; fails if any route lacks
  auth, authorization policy, schema (params/query/body/response), rate limit, audit flag,
  or at least one test referencing its route ID.
- **Log-leak test**: canary secrets (password, token, key, plaintext) injected in flows;
  asserts absence in captured logs and error responses.
- **Boundary test**: modules import only other modules' public `index.ts`.
- **Coverage gates**: 90% lines for `crypto-core`, `auth`, `messaging`, `devices`; 80% overall
  (coverage is a floor, not a goal).

## 5. Phase exit gate

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && cargo test && cargo clippy -D warnings`
green in CI plus the phase-specific suites in [implementation-plan.md](implementation-plan.md).
