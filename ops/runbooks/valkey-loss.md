# Runbook — Valkey loss

Alert: `RateLimitStoreUnavailable` (page); also `valkey.connection_error` warnings and the
readiness check (`/readyz` reports `valkey: fail`).

Valkey holds only disposable state (docs/architecture.md §10): rate-limit buckets, realtime
tickets and fan-out, presence, the push queue, caches. Nothing in it is the only copy of user
data. Measured behaviour during a loss is in [../../docs/dr-drills/](../../docs/dr-drills/).

**User impact while it is down.**
- Sign-in, sign-up and password reset are refused (their rate limits fail closed — brute-force
  protection must not lapse); other routes fall back to per-process limits.
- No new realtime connections (tickets live in Valkey) and no live fan-out: messages are still
  stored and arrive when clients sync.
- Pushes queued in Valkey since the last delivery may be lost; the next message wakes devices.

## Confirm

ElastiCache events (failover, node replacement), `valkey` in `/readyz`, client errors in logs.

## Mitigate

1. A Multi-AZ failover normally completes in under a minute; clients reconnect by themselves
   (ioredis retry). Do nothing but watch.
2. Cluster lost: create a replacement from Terraform (`terraform apply` recreates it empty), update
   the `VALKEY_URL` secret if the endpoint changed ([secrets.md](secrets.md)) and restart API and
   realtime pods (`kubectl -n tessera rollout restart deploy api admin-api realtime`).
3. Tell users through the status page that sign-in is temporarily unavailable.

## Resolved when

`RateLimitStoreUnavailable` clears, upgrades are accepted again and clients have resynced
(`messaging.sync` request rate back to its baseline).
