# Repository structure

Status: PROPOSED · Decisions: ADR-001, 027

```
.
├── apps/
│   ├── web/                  # React 19 + Vite SPA/PWA (user client)
│   │   ├── src/app.tsx       # routes + session guards
│   │   ├── src/pages/        # sign-up, sign-in, MFA, reset, settings/… (chats etc. from Phase 3)
│   │   ├── src/components/   # layouts (auth card, app shell), step-up dialog, offline banner
│   │   ├── src/api/          # typed client over shared Zod schemas (same-origin, CSRF header)
│   │   ├── src/state/        # session + step-up providers
│   │   ├── src/lib/          # WebAuthn wrapper, resource hook; (Phase 4) crypto worker
│   │   └── e2e/              # Playwright: full stack, virtual authenticator, CSP + axe checks
│   └── admin/                # separate admin SPA (separate origin, ZTNA)
├── services/
│   ├── api/                  # modular monolith (Fastify)
│   │   ├── src/modules/<domain>/{index.ts, routes.ts, service.ts, repo.ts, policy.ts, *.test.ts}
│   │   ├── src/platform/     # http pipeline (routes, errors, csrf, headers), db, valkey, rate-limit, migrations
│   │   ├── src/cli/          # migrate, openapi
│   │   ├── openapi.json      # generated contract, verified in CI
│   │   └── migrations/       # forward-only SQL
│   ├── realtime/             # WSS gateway
│   ├── notification/         # push/email workers
│   ├── media/                # scan/transcode/lifecycle workers
│   └── calling/              # TURN creds, LiveKit tokens, call state (may start as api module + worker)
├── packages/
│   ├── crypto-core/          # (Phase 4) Rust crate (OpenMLS, device certs, blob crypto) → WASM (+ UniFFI later)
│   ├── crypto/               # (Phase 4) TypeScript bindings/types for the worker RPC (no crypto logic)
│   ├── protocol/             # (Phase 3) Protobuf definitions (buf) + generated TS
│   ├── platform/             # server runtime: validated config, allow-list logger, AppError, health server, lifecycle
│   ├── shared/               # pure utilities (ids, assertNever) — no I/O
│   ├── validation/           # Zod schemas and inferred types shared by api/web (DTOs, problem details)
│   └── ui/                   # design system: tokens, themes, primitives (tokens.css, components.css)
├── infra/
│   ├── terraform/            # modules + envs (dev, staging, prod, dr)
│   ├── helm/                 # charts per service
│   └── docker/               # local compose: postgres, valkey, minio, livekit, coturn, mailpit
├── ops/
│   └── runbooks/             # incident, DR, regulatory reporting
├── tests/
│   ├── e2e/                  # Playwright multi-user/multi-device
│   ├── load/                 # k6
│   └── security/             # attack corpora, ZAP configs
├── docs/                     # this architecture package + future ADRs
├── .github/workflows/        # CI/CD
├── .env.example              # per service as well; never .env
├── .github/CODEOWNERS        # security-sensitive paths require designated reviewers
├── SECURITY.md               # vulnerability disclosure
├── pnpm-workspace.yaml · turbo.json · package.json · (Phase 4) Cargo.toml
├── tsconfig.base.json · eslint.config.js · .prettierrc.json · .editorconfig · .nvmrc
```

Shared tool configuration lives at the repository root (one ESLint flat config, one base
tsconfig) rather than in a `packages/config` package: with a single toolchain version per repo
that is simpler and avoids a build step for configuration. Domain types are inferred from the Zod
schemas in `packages/validation` instead of a separate `packages/types`.

Rules:
- `packages/shared` and `packages/validation` are dependency leaves (no I/O, no framework).
- `apps/*` may not import `services/*`; `services/*` may not import `apps/*`.
- Module code in `services/api/src/modules/X` may import only `modules/Y/index.ts`.
- Only `packages/crypto-core` contains cryptographic operations; `packages/crypto` is a typed RPC facade.
- Generated code is committed only where required for reproducible builds (protocol TS, OpenAPI document) and verified in CI (`git diff --exit-code` after regeneration).
- The web client does not use a generated API client: request/response schemas are shared from `packages/validation`, which is the single source of truth for both sides (the OpenAPI document is generated from the same schemas for other consumers).
