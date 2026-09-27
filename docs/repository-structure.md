# Repository structure

Status: PROPOSED · Decisions: ADR-001, 027

```
.
├── apps/
│   ├── web/                  # React 19 + Vite SPA/PWA (user client)
│   │   ├── src/app/          # routes, layouts (desktop 4-pane / mobile stack)
│   │   ├── src/features/     # auth, chats, groups, communities, channels, calls, settings, privacy
│   │   ├── src/workers/      # crypto.worker.ts (loads crypto-core WASM), sw.ts (service worker)
│   │   └── src/lib/          # api client (generated), realtime client, local db (via worker)
│   └── admin/                # separate admin SPA (separate origin, ZTNA)
├── services/
│   ├── api/                  # modular monolith (Fastify)
│   │   ├── src/modules/<domain>/{index.ts, routes.ts, service.ts, repo.ts, policy.ts, dto.ts, events.ts, *.test.ts}
│   │   ├── src/platform/     # http server, config, db, valkey, logger, telemetry, errors, rate-limit, outbox
│   │   └── migrations/       # forward-only SQL
│   ├── realtime/             # WSS gateway
│   ├── notification/         # push/email workers
│   ├── media/                # scan/transcode/lifecycle workers
│   └── calling/              # TURN creds, LiveKit tokens, call state (may start as api module + worker)
├── packages/
│   ├── crypto-core/          # Rust crate (OpenMLS, device certs, blob crypto) → WASM (+ UniFFI later)
│   ├── crypto/               # TypeScript bindings/types for the worker RPC (no crypto logic)
│   ├── protocol/             # Protobuf definitions (buf) + generated TS
│   ├── shared/               # pure utilities (ids, result types, time) — no I/O
│   ├── types/                # shared domain types
│   ├── validation/           # Zod schemas shared by api/web (DTOs, API contracts)
│   ├── api-client/           # generated from OpenAPI
│   ├── ui/                   # design system: tokens, primitives, components, icons
│   └── config/               # eslint, tsconfig, prettier, vitest presets
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
├── CODEOWNERS                # crypto-core + crypto docs require crypto reviewer
├── SECURITY.md               # vulnerability disclosure
├── pnpm-workspace.yaml · turbo.json · Cargo.toml · package.json
```

Rules:
- `packages/shared`, `types`, `validation` are dependency leaves (no I/O, no framework).
- `apps/*` may not import `services/*`; `services/*` may not import `apps/*`.
- Module code in `services/api/src/modules/X` may import only `modules/Y/index.ts`.
- Only `packages/crypto-core` contains cryptographic operations; `packages/crypto` is a typed RPC facade.
- Generated code is committed only where required for reproducible builds (protocol TS, API client) and verified in CI (`git diff --exit-code` after regeneration).
