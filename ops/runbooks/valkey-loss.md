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
  stored, and sockets already open stay open.
- When Valkey returns, every realtime pod asks its connections to reconnect, spread over
  `RESYNC_SPREAD_SECONDS` (60 s in production); clients catch up on what they missed (F-15).
  Expect a ticket and `messaging.sync` spike on the API for about a minute.
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

`RateLimitStoreUnavailable` clears, upgrades are accepted again, `tessera_realtime_resyncs_total`
has increased once per realtime pod (log `realtime.resync_requested`), the connection gauge is
back to its level before the loss and clients have resynced (`messaging.sync` request rate back
to its baseline). If a pod did not request a resync (its subscriber never reported the loss),
restart it: `kubectl -n tessera rollout restart deploy realtime`.
