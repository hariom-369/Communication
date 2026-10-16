# Runbook — restoring PostgreSQL

Targets (docs/disaster-recovery.md §1): corruption, a bad migration or operator error → RPO ≤ 5 min
(point-in-time recovery), RTO < 1 h. The database is the only store whose loss loses data: Valkey
is disposable, attachments are in versioned S3, and message history lives on users' devices (the
server keeps undelivered messages for 30 days).

## Decide what to restore

- **Point in time** (operator error, bad migration, corruption): RDS point-in-time restore to
  just before the event — RDS keeps 35 days. Find the moment from the audit log, CloudTrail or the
  first error; restore a few seconds before it.
- **Latest snapshot** (instance lost and Multi-AZ failover did not save it): restore the newest
  AWS Backup recovery point, here or in the DR region ([dr-region.md](dr-region.md)).

## Restore (new instance, never in place)

1. Declare an incident; freeze deploys; put the API in maintenance if writes would diverge
   (scale `api`, `admin-api` and `realtime` to 0 — clients keep their outbox and retry).
2. `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier tessera-<env>
   --target-db-instance-identifier tessera-<env>-restore-<date> --restore-time <UTC>
   --db-subnet-group-name tessera-<env> --vpc-security-group-ids <postgres sg> --multi-az`
   (or `restore-db-instance-from-db-snapshot` / an AWS Backup restore job). Same KMS key, same
   parameter group.
3. When available, **verify before switching**:
   - `DATABASE_URL=<restored, tessera_readonly> pnpm --filter @tessera/api verify-audit` →
     `{"ok":true,…}`. A broken chain means the copy is not trustworthy history; stop and escalate.
   - Migrations: `SELECT version FROM schema_migrations ORDER BY version` matches the running
     release (or is newer; never older).
   - Row counts of the large tables against the last known values (dashboards, or the old instance
     if it still answers).
4. Switch: update `DATABASE_URL` in the `api`, `realtime` and `migrate` secrets to the new endpoint
   (ops/runbooks/secrets.md), scale the deployments back, watch readiness and the SLO alerts.
5. Keep the old instance (stopped) until the incident review is done; then delete it.

## Rehearsed

`ops/dr/restore-drill.sh` performs the same checks around a pg_dump/pg_restore copy and reports
the times; run it monthly against staging and record the result in docs/dr-drills/. RDS restore
times themselves (minutes to an hour, by size) are measured in staging, not locally.
