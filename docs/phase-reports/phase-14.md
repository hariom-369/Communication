# Phase 14 report — PWA and web optimisation

**Status: GREEN locally; pending security review S-03.** Verified 2026-10-10. CI has not run,
because the branch still cannot be pushed (GitHub returns 403 for the Claude app).

The web app now runs from a copy of a release this browser has verified against a signed
manifest, opens offline, can be installed, loads the sign-in pages with a third less script, and
passed an automated WCAG 2.2 AA sweep of every route in both themes at desktop and phone widths
(four real problems found and fixed). Design and limits: **ADR-052**, [e2ee.md §7](../e2ee.md),
[performance.md](../performance.md), [accessibility.md](../accessibility.md).

## Results

| Gate | Result |
|---|---|
| Format, lint, typecheck, build (incl. bundle budgets) | pass |
| Unit tests | **638 TypeScript** (api 398, web 144, ui 65, platform 15, shared 7, realtime 3, validation 3, admin 3) + **78 Rust** (3 new: release manifest verification) |
| Integration (real PostgreSQL + Valkey + S3-compatible store + coturn) | **239 passed** (api 222, realtime 17); 2 skipped (IPv6 TURN test without IPv6 here; opt-in channel scale test) — unchanged, no API changes |
| End-to-end, user app (Chromium, production build, strict CSP + Trusted Types, real services) | **59 passed in each of 3 consecutive full runs** (12 new: 5 PWA, 2 Web Vitals, 1 Lighthouse, 4 accessibility); 1 skipped (opt-in call load test). An earlier full run failed 7 tests — the code-splitting CSP regression below, fixed before these runs |
| End-to-end, admin console | **6 passed** in runs 1 and 3–5; run 2 failed before any test (identity provider port, below) and was fixed; runs 3–5 are three consecutive green runs on the final code, run 3 directly after a full user-app run; now run in CI |
| Mutation checks | **8 of 8** seeded faults caught (below) |
| Lighthouse 13.5.0 (mobile profile) | `/login` performance 0.95, accessibility 1.00, best practices 0.96; `/signup` 0.94–0.96 / 1.00 / 0.96 (3 runs) |
| Web Vitals (CPU slowed 4×) | LCP 308–1044 ms, CLS ≤ 0.001, INP 32 ms (last run) |
| OpenAPI | unchanged (no API changes) |
| `pnpm audit` (all, incl. dev) / gitleaks | no known vulnerabilities after overriding `source-map-js` to ≥ 1.2.2 (GHSA-68fv-2mgg-jv7q, dev/build only, published 2026-09-30) / no leaks (history and every file to be committed) |

### Exit criteria

| Criterion | Evidence |
|---|---|
| **Lighthouse / Web Vitals budgets** | `e2e/lighthouse.spec.ts` (performance ≥ 0.90, accessibility 1.00, best practices ≥ 0.90 on the public pages), `e2e/performance.spec.ts` (LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms, first visit and pinned, signed out and signed in), `scripts/budgets.mjs` on every build (entry 152.7 / 170 KB gzip; numbers in performance.md) |
| **WCAG 2.2 AA audit** | `e2e/accessibility.spec.ts`: 16 routes × 2 themes × 2 widths — axe WCAG 2.0–2.2 A/AA rules, reflow, text spacing, focus visible and not obscured; skip link; reduced motion. Criteria automation cannot decide are listed in accessibility.md with their evidence; screen-reader passes are not done yet |

## Delivered

- **Signed release manifest** (`scripts/release.mjs`, `crypto-core/src/release.rs`): SHA-256 of
  every served file, release sequence, next trusted keys; Ed25519 over a domain-separated
  message; SRI on everything `index.html` loads; unofficial builds marked and refusable in
  production pipelines.
- **Pinned app shell** (`src/sw/release.ts`): install only what verifies (trust on first use,
  then the running release's keys; no rollback; every file hashed); per-install cache removed on
  failure; pages and release files served from the verified copy with their CSP; offline start
  with "Cannot reach Tessera"; API, realtime, SFU and media untouched.
- **Refused updates are visible**: the page says when an update did not verify and keeps
  running the verified release.
- **Monitor** (`scripts/verify-release.mjs`): checks a live deployment against its manifest; run
  in CI after the build.
- **Installable**: web app manifest, icons (192, 512, maskable, Apple touch) rendered from the
  mark by `scripts/icons.mjs`, theme colours; Settings → Account → "This app" offers the
  browser's install prompt where it exists and shows which verified release this browser runs.
- **Performance**: route-level code splitting (entry 238 → 153 KB gzip); bundle budgets in the
  build; Web Vitals and Lighthouse budgets in E2E.
- **Reduced motion**: a global rule on top of the zeroed motion tokens.
- **Accessibility fixes**: reflow at 320 px (four pages), text spacing (chat list), text-field
  contrast (new `controlBorder` token, unit-tested), skip link moves focus.
- **CI**: the admin console E2E suite and the release-manifest check now run in the E2E job.

## Tests added

- `src/sw/release.test.ts` (5): install and serve; untrusted signer refused (also when the new
  worker embeds it); tampered file, rollback, foreign manifest, missing file refused and nothing
  left behind; key hand-over; development builds do not pin.
- `crypto-core` `release.rs` (3): a trusted key's signature verifies; another key, a changed
  manifest, a truncated signature, malformed or no keys, and a signature without the context
  string are refused; SHA-256 test vector.
- `e2e/pwa.spec.ts` (5): installed and offline; server-side tampering not used and detected by
  the monitor; mismatching release not installed; forged update refused with the notice;
  installable in a normal profile with every icon pinned.
- `e2e/performance.spec.ts` (2), `e2e/lighthouse.spec.ts` (1), `e2e/accessibility.spec.ts` (4).
- `packages/ui` contrast test: three control-border pairings per theme.

### Mutation checks (8/8 caught)

Embedded keys always trusted (attacker key accepted) · file digests not checked at install ·
partial cache not removed after a failed install · button focus ring removed — each caught by
E2E; untrusted signer accepted · rollback allowed · foreign manifest accepted · missing file
ignored — caught by the unit tests.

The first version of the "mismatching release" test passed even with digest checks removed (it
looked before installation had started); it now follows the installing worker to its final
state, and the mutation is caught.

## Problems found and fixed during the phase

- **Code splitting broke the CSP guarantee** in the first full E2E run (7 tests failed on Trusted
  Types violations): the shared chunk created Zod schemas before `zod-config.ts` turned Zod's
  JIT off, so Zod probed `Function`. The build now preserves source execution order across
  chunks (`strictExecutionOrder`); the same 7 tests pass, and the full runs below include them.
  The targeted PWA, performance and accessibility specs had passed because they do not record
  CSP violations — the full suite is what caught it.

- **Admin E2E start-up failure, explained.** One admin run failed before any test: its test
  identity provider got `EADDRINUSE` on its fixed port 58300 and setup then waited 30 s for it.
  Nothing answered on that port, so it was not a leftover provider: 58300 lies in Linux's
  ephemeral port range (32768–60999), where an outgoing connection of the preceding user-app run
  can hold it. This is the likely cause of the Phase 13 open item too. The provider now listens
  on a port the system assigns and announces its issuer; setup fails at once if it exits.
- A failed installation left a partly filled cache under the running release's name, which a
  later failure could have deleted; each installation now has its own cache.
- The group-call E2E test failed once in the full run (34 video frames where it wanted > 50): it
  sampled the first 300 frames, and video frame rate drops while the inspector's new browser
  context installs the release. It now waits for enough video frames explicitly; it passed 3
  times alone before the change.
- Installability cannot be checked in a private browser context (Chromium never installs
  there); the test uses a normal profile.

## Security implications (threat-model delta)

Recorded in [threat-model.md](../threat-model.md) (Phase 14 delta), [security.md](../security.md)
§3 and §10, [e2ee.md §7](../e2ee.md) and ADR-052. In short: returning browsers no longer accept
tampered, partial or rolled-back asset files or updates signed by unknown keys, and say when an
update was refused; every release is attributable to the signing key and checkable by anyone.
Residual: the first visit trusts the server; a malicious `sw.js` plus the signing key can ship
anything; signing-key custody becomes critical (loss without a successor strands browsers on the
last release); no transparency log or reproducible builds yet.

## Open items

- `source-map-js` 1.2.2 is ten days old (the override is a security fix for a dev/build-time
  dependency); drop the override once vitest and the bundler require it themselves.
- Lighthouse best practices: the expected 401 of the signed-out session check is logged by the
  browser as a console error; a session probe that answers 200 for "signed out" would remove it
  (API change, not made here).

## Moved / not done

- **Background sync** → with the persisted, encrypted outbox (before public beta). Queued
  messages already retry when the app reconnects; sending from the service worker while no tab
  is open needs the outbox on disk and MLS sends in the worker under the device lock, and the
  Background Sync API exists only in Chromium.
- **Streamed uploads above 1 GB** (from Phase 13) → before public beta; the 1 GB paid limit
  stays.
- **Document viewers on the user-content origin** (from Phase 6) → with that origin's
  deployment (Phase 17); documents remain downloads.
- **Firefox and Safari push / PWA tests** (from Phase 10) → CI browser matrix (Phase 15); only
  Chromium exists in this environment.
- **Support-assisted account recovery** (from Phase 12) → before public beta, once identity
  proofing and the waiting-period policy are decided (operations and counsel); staff still
  cannot bypass a second factor.
- Public transparency log for releases and reproducible builds → release pipeline (Phase 15/17).
- Screen-reader passes and an external accessibility audit → Phase 16.

## Commit

Branch `claude/trusting-goodall-55613i`. Push still blocked (403) — the user needs to reconnect
GitHub with the Claude app installed (https://claude.ai/connect-github).
