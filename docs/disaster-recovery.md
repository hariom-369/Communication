# Disaster recovery

Status: PROPOSED

## 1. Targets

| Scenario | RPO | RTO |
|---|---|---|
| Single AZ loss | 0 (Multi-AZ synchronous) | < 5 min (automatic failover) |
| Primary DB corruption / bad migration / operator error | ≤ 5 min (PITR) | < 1 h |
| Full region loss (ap-south-1) | ≤ 15 min (cross-region replicas/snapshots) | < 4 h (beta) → < 1 h (GA+1) |
| Valkey loss | N/A (disposable; rebuilt) | < 15 min, degraded mode meanwhile |
| Object storage (e2ee-media) region loss | ≤ 15 min (S3 CRR) | < 4 h |
| Credential / KMS key compromise | — | runbook-driven rotation < 4 h |

E2EE message history is primarily on user devices; server-side loss of the 30-day
mailbox affects only undelivered messages (bounded by RPO).

## 2. Backups (platform data — distinct from users' E2EE backups)

- RDS automated backups + PITR (35 days); daily snapshots copied to ap-south-2 and to a
  separate "backup vault" AWS account (AWS Backup, Vault Lock / immutable) — protects
  against account compromise and ransomware.
- Snapshots encrypted with KMS keys that also exist (multi-region keys) in the DR region.
- S3: versioning + CRR for critical buckets; Object Lock on audit exports.
- Terraform state and IaC in Git — infrastructure is re-creatable.
- Secrets: replicated to DR region.

## 3. Restore testing (mandatory)

"We have backups" is not a DR plan. Schedule:
- **Weekly (automated):** restore latest snapshot into an isolated staging account, run
  schema checks + row-count sanity + application smoke tests against it; publish result
  metric; alert on failure.
- **Monthly:** PITR restore to a random timestamp; verify.
- **Quarterly:** full regional failover game day in staging; annually a controlled
  production failover drill (or partial) before GA.
- Every test records measured RPO/RTO; targets revised if not met.

## 4. Regional failover procedure (summary; full runbook in `ops/runbooks/dr-region.md`)

1. Declare incident; freeze deploys.
2. Promote cross-region read replica (or restore latest snapshot + WAL) in ap-south-2.
3. Scale up pre-provisioned (pilot-light) EKS cluster via Terraform/Helm.
4. Switch Route 53 records (health-check driven for API/realtime; manual confirmation).
5. Clients reconnect; they resync via cursors; devices re-send QUEUED messages (idempotent).
6. Post-incident: data reconciliation, failback plan.

## 5. Other runbooks required before beta

Bad deploy rollback; runaway migration; Valkey failover; S3 permission misconfiguration;
KMS key disablement; leaked secret rotation; DDoS; mass account takeover; CSAM report
escalation; CERT-In 6-hour incident reporting; DPDP breach notification.
