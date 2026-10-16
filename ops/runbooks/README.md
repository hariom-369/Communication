# Runbooks

Every alert in `infra/monitoring/alerts.yaml` links to one of these (checked by
`infra/k8s/src/alerts.test.ts`). Each runbook says what the alert means for users, how to
confirm it, how to stop the damage, and how to know it is over. Commands assume the on-call
break-glass role in the cluster (`kubectl -n tessera …`) and Grafana/Loki access
([on-call.md](on-call.md)). Logs are structured JSON; filter on `event`
(`{namespace="tessera"} | json | event="…"`).

| Runbook | For |
|---|---|
| [incident-response.md](incident-response.md) | Any incident: roles, severities, CERT-In 6 h and DPDP reporting |
| [on-call.md](on-call.md) | Rotation, paging, hand-over, access |
| [api-errors.md](api-errors.md) | API 5xx, message-send errors and latency, event-loop lag |
| [realtime.md](realtime.md) | WebSocket upgrades refused, slow consumers, file descriptors |
| [background-jobs.md](background-jobs.md) | Sweepers, scheduler, push queue age |
| [valkey-loss.md](valkey-loss.md) | Valkey down or failing over |
| [breached-password-mirror.md](breached-password-mirror.md) | Mirror unreachable, monthly refresh |
| [link-fetcher.md](link-fetcher.md) | Isolated link-preview fetcher |
| [deploy-rollback.md](deploy-rollback.md) | Deploys, rollback, pods down |
| [runaway-migration.md](runaway-migration.md) | A migration Job that hangs or fails |
| [dr-restore.md](dr-restore.md) | Restoring PostgreSQL (snapshot / PITR), the restore drill |
| [dr-region.md](dr-region.md) | Regional failover to ap-south-2 |
| [secrets.md](secrets.md) | Secret contracts, rotation, a leaked secret |
| [kms-key.md](kms-key.md) | KMS key disabled, scheduled for deletion or compromised |
| [s3-misconfiguration.md](s3-misconfiguration.md) | Bucket policy or public-access changes |
| [ddos.md](ddos.md) | Volumetric or application-layer floods |
| [account-takeover.md](account-takeover.md) | Credential stuffing, mass takeover |
| [csam-escalation.md](csam-escalation.md) | Known-CSAM hash match escalation |
| [release-signing-key.md](release-signing-key.md) | Web release signing key |
