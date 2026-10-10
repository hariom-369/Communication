# Contributing

## Prerequisites

- Node.js 24 LTS (`.nvmrc`; ≥ 22.12 works for local development) and pnpm 10 (`corepack enable`).
- Docker (for local PostgreSQL 17 and Valkey 8).
- Rust via rustup: the crypto core pins its toolchain and the `wasm32-unknown-unknown` target in
  `packages/crypto-core/rust-toolchain.toml` (installed automatically on first build), plus the
  matching WebAssembly bindings generator:
  `cargo install wasm-bindgen-cli --version 0.2.129 --locked`.

## Setup

```sh
pnpm install
docker compose -f infra/docker/compose.yaml up -d
cp services/api/.env.example services/api/.env             # local only; never commit .env
cp services/realtime/.env.example services/realtime/.env   # local only
```

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm check` | format check, lint, typecheck, build, unit tests — run before every push |
| `pnpm test` | unit tests (no external services) |
| `pnpm test:integration` | integration tests against real PostgreSQL + Valkey (see below) |
| `pnpm openapi` | regenerate `services/api/openapi.json` (CI fails if it is stale) |
| `pnpm --filter @tessera/web dev` | web app with hot reload on http://localhost:5173 (proxies `/api` to :8080 and `/rt` to :8081) |
| `pnpm --filter @tessera/realtime start` | realtime WebSocket service on :8081 (after `pnpm build`) |
| `pnpm --filter @tessera/crypto-core lint` | `rustfmt --check` and `clippy -D warnings` for native and wasm32 targets (`pnpm test` runs `cargo test`) |
| `cargo +nightly fuzz run <target>` (in `packages/crypto-core`) | fuzz `certificate`, `padding`, `snapshot`, `inbound`, `backup` or `media` (needs `cargo install cargo-fuzz`; CI fuzzes nightly) |
| `pnpm --filter @tessera/web test:e2e` | end-to-end tests: starts API + realtime + SMTP capture and serves the production build (needs the `TEST_*` variables; run `pnpm build` first) |
| `pnpm --filter @tessera/api migrate` | apply database migrations (after `pnpm build`) |
| `pnpm --filter @tessera/api start:admin` | admin API (`/admin/v1`) on :8082, a separate process (docs/admin.md; needs the `ADMIN_*` settings) |
| `pnpm --filter @tessera/admin dev` | admin console with hot reload on http://localhost:5174 (proxies `/admin/v1` to :8082) |
| `pnpm --filter @tessera/api admin create <email> <name> --by <you>` | break-glass operator command: bootstrap admins, grant roles (`grant <email> <role> --hours <n>`), eligibility, disable, list — audited |
| `pnpm --filter @tessera/admin test:e2e` | admin console end-to-end tests: starts a test identity provider, the admin API and the production build (needs the `TEST_*` variables; run `pnpm build` first) |

Integration tests need these variables and **fail rather than skip** without them:

```sh
export TEST_DATABASE_URL=postgres://tessera:tessera-local-only@localhost:5432/tessera
export TEST_VALKEY_URL=redis://localhost:6379
# S3-compatible store for encrypted attachments. Tests create their own buckets, which the
# moto emulator allows without credentials (CI uses it too):
#   python3 -m pip install --user "moto[server]==5.2.3" && moto_server -H 127.0.0.1 -p 59500
export TEST_S3_URL=http://127.0.0.1:59500
```

The local MinIO in the compose file (console at http://127.0.0.1:9001) backs the dev API
(`MEDIA_S3_*` in `services/api/.env.example`).

Locally, Mailpit (in the compose file) shows every email at http://127.0.0.1:8025.

Chats are end-to-end encrypted in every build. To try them locally, use two browser profiles
(each keeps its own encryption keys in IndexedDB). Changes to `packages/crypto-core` or to
`docs/crypto-design.md` need review by the cryptography code owner.

## Adding an API endpoint

1. Define it with `defineRoute` in `services/api/src/modules/<module>/routes.ts`. The type requires
   authentication, an authorization policy, Zod schemas, a rate limit and an audit decision.
2. Export it through the module's `index.ts`; other modules may import only that file.
3. Add tests that reference the route id (e.g. `'meta.version'`) — the completeness test fails otherwise.
4. Run `pnpm openapi` and commit the updated contract.

## Database migrations

Forward-only SQL files `services/api/migrations/NNNN_description.sql`. Follow expand → migrate →
contract; never edit an applied migration (the runner detects it). Use
`-- migrate:no-transaction` as the first line for `CREATE INDEX CONCURRENTLY`.

## Logging

Use the structured logger: `log.info('module.event_name', { allowListedField })`. Only fields in
`packages/platform/src/logger.ts#LOG_FIELDS` are emitted. Never log message content, tokens,
credentials, keys, file names or request bodies.

## Definition of Done

See [`docs/implementation-plan.md`](docs/implementation-plan.md#definition-of-done).
