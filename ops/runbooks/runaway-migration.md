# Runbook — a migration that hangs or fails

The deploy applies `migrate-<release>` and waits up to 30 minutes for it before touching any
workload (deploy.yml). Migrations are expand-only, so the running release keeps working while a
migration runs or after it fails.

## It fails

The Job's log (`kubectl -n tessera logs job/migrate-<release>`) shows `migration.run_failed` with
the migration name. Each migration runs in its own transaction, so a failed one left nothing
behind; earlier ones of the same release stay applied (they are expand-only and harmless to the
old code). Fix forward in a new release; never edit an applied migration (the checksum in
`schema_migrations` is compared at boot and on readiness).

## It hangs

1. Lock waits: `SELECT pid, wait_event_type, wait_event, state, query FROM pg_stat_activity WHERE application_name = 'tessera-migrate';`
   and what it waits for: `SELECT * FROM pg_locks WHERE NOT granted;` — usually a long API
   transaction or a vacuum on a big table.
2. Cancel the migration if it blocks traffic (an `ACCESS EXCLUSIVE` lock queues every query
   behind it): `SELECT pg_cancel_backend(<pid>);` The Job fails, the deploy stops, nothing changed.
3. Rewrite the migration to not hold strong locks: `CREATE INDEX CONCURRENTLY` (outside a
   transaction), `ADD COLUMN` without a volatile default, `NOT VALID` constraints validated later.

## The schema is ahead of the code after a rollback

Expected and fine (expand-only). The readiness check compares applied migrations against those
the running code knows; a rolled-back API sees *extra* migrations, which it accepts.
