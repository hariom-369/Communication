# Contributing

## Prerequisites

- Node.js 24 LTS (`.nvmrc`; ≥ 22.12 works for local development) and pnpm 10 (`corepack enable`).
- Docker (for local PostgreSQL 17 and Valkey 8).

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
| `pnpm --filter @tessera/web build:dev-messaging` | web build **with** the development (unencrypted) chat, into `dist-dev-messaging/` — never deploy it (ADR-038) |
| `pnpm --filter @tessera/web verify:bundle` | fails if the production bundle contains development-only messaging code (run after `pnpm build`) |
| `pnpm --filter @tessera/web test:e2e` | end-to-end tests: starts API + realtime + SMTP capture and serves the `dist-dev-messaging` build (needs the `TEST_*` variables; run `pnpm build` and `build:dev-messaging` first) |
| `pnpm --filter @tessera/api migrate` | apply database migrations (after `pnpm build`) |

Integration tests need these variables and **fail rather than skip** without them:

```sh
export TEST_DATABASE_URL=postgres://tessera:tessera-local-only@localhost:5432/tessera
export TEST_VALKEY_URL=redis://localhost:6379
```

Locally, Mailpit (in the compose file) shows every email at http://127.0.0.1:8025.

To try chat locally, set `MESSAGING_DEV_PLAINTEXT=true` in `services/api/.env` (rejected in
production) and run the web app with `VITE_DEV_PLAINTEXT_MESSAGING=true`. Every screen then shows
a "not end-to-end encrypted" banner.

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
