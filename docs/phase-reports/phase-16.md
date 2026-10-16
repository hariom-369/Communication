# Phase 16 report — Security audit preparation

**Status: GREEN locally.** Verified 2026-10-16. The external penetration test and cryptographic
audit (S-13) are prepared, not performed: they need independent assessors and a staging
environment (Phase 17).

The internal review checked every security claim in the documents against the code, reviewed
every route through a matrix generated from the code, and ran every scanner reachable from this
environment. It found **14 issues: 1 high, 8 medium, 5 low. All fixed except four mediums that
need a deployment, a release pipeline or a product decision**, each scheduled. Exit criterion
"no open critical/high findings": **met**. Details: [security/review.md](../security/review.md).

## Results

| Gate | Result |
|---|---|
| Format, lint, typecheck, build | pass (lint after fixing three type-aware lint errors in the new breached-password unit test) |
| Unit tests | **673 TypeScript** (api 414, web 152, ui 65, platform 15, shared 9, load 8, realtime 4, validation 3, admin 3) + **78 Rust** — new: breached-password checker, linear domain scan with a timing bound, UUIDv7 ids in decrypted content (`__proto__` regression), admission spread draw, route-matrix invariants (9) |
| Integration (real PostgreSQL + Valkey + S3-compatible store + coturn) | **246 passed** (api 227, realtime 19); 2 skipped (IPv6 TURN without IPv6 here; opt-in channel scale test) — new: passkey registration step-up on active accounts, breached password refused at sign-up, change and reset (local mirror), presigned download headers |
| End-to-end, user app (Chromium, production build, real services) | **60 passed (1 skipped: opt-in call load test) in each of 3 consecutive runs** — new: stored XSS across group names, file names, channel titles and posts |
| End-to-end, admin console | **6 passed in each of 3 consecutive runs** |
| Mutation checks | every new test fails on the code it guards: step-up removed from passkey registration (integration and matrix invariant), breached check skipped (unit and integration), old quadratic regex (timing test), unvalidated message reference (regression test) |
| Route matrix | regenerated, no drift (CI checks it) |
| OpenAPI | regenerated: ids in mailbox messages now declare length 36 (UUIDv7) |
| `pnpm audit` / gitleaks | no known vulnerabilities / no leaks (full history, 37 commits) |

## Delivered

- **Findings register and internal review** ([security/review.md](../security/review.md)):
  method, 14 findings with severity and status, route review, scanner results, what this review
  does not cover.
- **Route security matrix** ([security/route-matrix.md](../security/route-matrix.md)) generated
  from the route definitions (`pnpm --filter @tessera/api security-matrix`; CI fails on drift),
  and **`security-matrix.test.ts`** enforcing what the review relies on: reviewed lists of
  unauthenticated routes and of admin routes without a capability, public state-changing routes
  failing closed, GET never auditing (so never changing state), every factor-adding route
  requiring re-authentication, sane rate limits everywhere.
- **ASVS 5.0 self-assessment** ([security/asvs.md](../security/asvs.md)) by chapter and control
  area with code and test evidence — the input to the external verification, which checks it
  requirement by requirement.
- **Threat model refresh**: an as-built status for every threat (built and tested / deployment
  property / not built), and T-29 (documents claiming controls the code lacks).
- **External assessment brief** ([security/audit-brief.md](../security/audit-brief.md)): system
  summary, crypto-audit questions per review item (S-01..S-12), pentest scope, environment, rules
  of engagement, deliverables.
- **Vulnerability disclosure and bug bounty policy** ([security/bug-bounty.md](../security/bug-bounty.md))
  and an updated [SECURITY.md](../../SECURITY.md): reporting, response targets, safe harbour
  (wording for counsel, L-15), scope; the paid bounty opens after GA without promised amounts.

## Findings fixed in this phase

| ID | Severity | Fix | Test |
|---|---|---|---|
| F-11 | high | passkey registration on an active account requires a recent re-authentication (`stepUp: 'when-active'`) — a stolen session can no longer add its own passkey | integration test, mutation-checked; matrix invariant |
| F-04 | medium | breached-password check against a mirror of the Pwned Passwords range API (5-character prefix only; fails open with a warning; required in production) | unit + integration (local mirror), mutation-checked |
| F-12 | medium | bare-domain extraction for link checks was quadratic (4 s for 64 KiB); linear scan in `@tessera/shared`, used by API and web | unit test with a timing bound on the old worst case |
| F-13 | medium | message references in decrypted content and server-sent sender/device/message ids validated as UUIDv7, so `__proto__` cannot key client state | regression test |
| F-01 | low | lint rule against Kysely's unparameterised SQL escape hatches | lint |
| F-02 | low | OSV scan covers the crypto core's `Cargo.lock` | CI |
| F-03 | low | presigned downloads pin `application/octet-stream` and `attachment` | integration test |
| F-08 | low | literal bidi characters in a validation regex written as escapes | security lint |
| F-10 | low | stored-XSS end-to-end test for group names, file names, channel titles and posts | E2E |

(F-07, an API crash on a background job's database timeout, was found and fixed in Phase 15.)

## Open findings (scheduled)

| ID | Severity | What | When |
|---|---|---|---|
| F-05 | medium | link-preview fetcher isolated with its own egress proxy | Phase 17 deployment |
| F-06 | medium | SBOM, image scanning and signing, SLSA provenance, `cargo deny` (reproducible builds and a transparency log may follow GA) | Phase 17 release pipeline |
| F-09 | medium | risk-based challenges, credential-stuffing detection, risk-triggered MFA | before public beta |
| F-14 | medium | API headroom and realtime pod size for a pod crash, measured in staging | Phase 17 |

## Problems found and fixed during the phase

- My first version of a claims check listed a missing `localStorage` lint rule; the rule existed
  (`no-restricted-globals`). The duplicate was removed before commit — a reminder that every
  finding here was confirmed in the code before it was recorded.
- `crypto.randomInt(0, 2 ** 48)` throws (the range must be below 2^48): the load harness's random
  draws failed silently and the admission spread would have answered 500. Caught by a smoke run;
  32-bit `getRandomValues` draws with a unit test.
- gitleaks' generic rule matched a prose table row of the audit brief; the commit was amended and
  re-pushed within a minute, and every later commit checks gitleaks' own exit code.
- The new XSS test first used payloads longer than the group-name limit (80 characters) and a
  non-contact as group member (which makes an invitation, not a membership); both were test
  mistakes, the product behaved as designed.
- Making ids strict broke 20 web unit tests whose fixtures used labels like `'m1'`; they now use a
  deterministic `testId()` helper. A branded id type leaking into the content types was avoided
  with an unbranded schema (TypeScript infers type predicates from arrow functions — an explicit
  `boolean` return type stops it).
- The same change broke one realtime integration test deterministically: its fixture published
  messages with random (version 4) UUIDs, which the gateway now drops as invalid events. The
  product was right (clients and the send schema already use UUIDv7); the fixture now does too.

## Security implications

This phase changes security posture rather than adding features: one high finding closed
(F-11), three mediums closed (F-04, F-12, F-13), the documents corrected to what is built
(T-29), and every route's security properties now generated and tested. No new data flow
except the breached-password mirror, which receives only 5-character hash prefixes and is
operated by us.

## Moved / not done

- External penetration test and cryptographic audit (S-13) → performed by independent assessors
  against staging (Phase 17) before public beta; brief ready.
- Rust advisory scanning locally → CI only (OSV and RustSec unreachable from this environment).
- Paid bug bounty → after GA (business decision on amounts).
- F-05, F-06, F-09, F-14 → as scheduled above.

## Commit

See the git log of branch `claude/trusting-goodall-55613i`: the Phase 16 work is in the commits
prefixed "Phase 16"; this report closes the phase.
