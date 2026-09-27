# Phase 1 report — Repository, tooling, CI/CD, platform foundations

**Status: GREEN** (locally verified 2026-09-27; CI has not run yet because the branch could not be
pushed — see "Known gaps").

## Results

| Gate | Result |
|---|---|
| `pnpm format:check` | pass |
| `pnpm lint` (typed, strict, security rules) | pass, 0 warnings |
| `pnpm typecheck` | pass |
| `pnpm build` | pass |
| `pnpm test` (unit) | **125 passed** — shared 7, validation 3, platform 15, api 45, ui 55 |
| `pnpm test:integration` (PostgreSQL 16 + Redis 7 locally; CI uses PostgreSQL 17 + Valkey 8) | **13 passed** |
| OpenAPI regenerated, matches committed file | pass |
| Secret scan (gitleaks 8.30.1, tree + history) | no leaks |
| `pnpm audit` | no known vulnerabilities |
| Dependency licences | MIT, ISC, BSD, Apache-2.0, MPL-2.0, BlueOak, CC0/CC-BY (no copyleft-network licences) |
| Boot smoke test (migrate CLI → server → `/api/v1/meta/version`, `/readyz`, SIGTERM drain) | pass |

## What was built

- **Monorepo**: pnpm workspaces + Turborepo; strict TypeScript (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, …); exact dependency pins; install scripts disabled.
- **Lint rules with security intent**: no `any`, no `eval`/`Function`, no `Math.random`, no
  `localStorage`/`sessionStorage`, no `dangerouslySetInnerHTML`, no `console`.
- **`packages/platform`**: Zod-validated config that reports variable names only (never values);
  allow-list structured logger (unknown fields and non-primitive values are dropped; free-text
  event names rejected; third-party error text omitted in production); `AppError`; internal health
  server (`/livez`, `/readyz`, `/startupz`, no error details); lifecycle with drain + ordered
  shutdown + timeout.
- **API pipeline (`services/api`)**: security headers + HSTS; CSRF (custom header, Origin
  allow-list, Fetch-Metadata); CORS allow-list; RFC 9457 problem+json errors with `errorId`
  correlation and no internals; server-generated UUIDv7 request IDs; body limit; prototype
  pollution rejection; response DTO stripping; `defineRoute` contract (auth, policy, schemas,
  rate limit, audit decision) + completeness test; module-boundary test; OpenAPI 3.1 generation.
- **Rate limiting**: GCRA executed atomically in Valkey with server time; IPv6 limited per /64;
  degraded mode — `closed` policies reject, `open` policies fall back to a bounded in-process limiter.
- **Migrations**: forward-only SQL, checksums, advisory lock, per-migration transactions,
  `-- migrate:no-transaction`, rollback tolerance for newer migrations, readiness check.
  `0001_extensions.sql` (citext, pg_trgm).
- **Design system (`packages/ui`)**: original Tessera palette (terracotta/lagoon on warm neutrals),
  light/dark themes following OS preference with explicit override, reduced-motion support,
  WCAG 2.2 AA contrast verified for every pairing by tests; `Button`, `Skeleton`, `VisuallyHidden`
  with axe-core checks.
- **CI**: verify job, integration job (service containers), gitleaks (checksum-verified binary),
  OSV-Scanner, dependency review (licence deny-list), CodeQL; all actions pinned by SHA;
  read-only default token permissions. Dependabot for npm + actions.
- **Governance**: `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, `.env.example`, local compose.

## Security implications reviewed

- New attack surface: one public, read-only endpoint (`GET /api/v1/meta/version`) exposing build
  version/commit. Accepted: needed for client compatibility; rate-limited. Consider hiding the
  commit hash in production if it aids attackers (low risk).
- Health endpoints are on a separate port; verified not reachable on the public port.
- Threat-model entries addressed in code: T-14 (headers/CSP for API), T-15 groundwork (Origin
  allow-list), T-18 (rate limits), T-19/T-20 (pinned actions, lockfile, audit, secret scan), T-25
  (strict validation, proto-poisoning defence).

## Known gaps (explicitly not done in Phase 1)

- **Push to GitHub failed (HTTP 403, app access)**, so CI has not executed yet. Workflows were
  written against pinned action SHAs and the gitleaks step was executed locally as scripted.
- Moved to later phases (see implementation plan): web app shell + Playwright (Phase 2), Rust
  toolchain (Phase 4), realtime service (Phase 3), Terraform (before first shared environment),
  container images + SBOM + signing (Phase 2).
- Metrics/tracing (OpenTelemetry) not wired yet — will land with the first container deployment.
- Docker is not available in the development container used for this phase; integration tests
  ran against locally started PostgreSQL 16 / Redis 7 rather than the compose file's PostgreSQL 17 /
  Valkey 8. CI uses the production-equivalent versions.

## Next phase

Phase 2 — Authentication, accounts, devices. Blocked items to resolve first: **L-02/L-03**
(phone number as identifier) and **L-06** (age gate); Phase 2 can start with email + passkey +
password flows, which do not depend on them.
