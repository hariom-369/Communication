# Deployment architecture

Status: PROPOSED · Decision: ADR-023

## 1. Environments

| Env | Purpose | Data | Access |
|---|---|---|---|
| local | developer machines | docker compose: Postgres, Valkey, MinIO, LiveKit, coturn, Mailpit | developers |
| dev (shared) | integration of main branch | synthetic | engineering |
| staging | production-like, release candidates, load & DR tests | synthetic (never production personal data) | engineering, QA |
| production | users | real | on-call via break-glass; CD pipeline |

Separate AWS accounts per environment (AWS Organizations, SCPs), separate KMS keys, no
network path between staging and production.

## 2. Production topology (ap-south-1, 3 AZs)

```
Route 53 ─▶ CloudFront (+ WAF, Shield) ─┬─▶ S3 (web static, public media)
                                         └─▶ ALB ─▶ EKS: api pods (HPA), admin-api pods (ZTNA-only ingress)
NLB (TCP 443, WSS) ─▶ EKS: realtime pods (HPA on connections)
NLB (UDP/TCP) ─▶ EC2/EKS node group (host network): coturn, LiveKit SFU
EKS workers: media, notification, jobs, outbox relay, link-preview fetcher (isolated egress)
RDS PostgreSQL 17 Multi-AZ (+ read replica) · ElastiCache Valkey (cluster mode, Multi-AZ)
S3 buckets (see media.md) · KMS · Secrets Manager · CloudWatch/AMP/Loki
DR region: ap-south-2 (Hyderabad) — see disaster-recovery.md
```

## 3. CI/CD

```
PR → checks: typecheck · lint · unit · integration (testcontainers) · Rust tests + clippy +
            cargo deny · buf breaking · OpenAPI diff · migration lint · SAST (Semgrep/CodeQL) ·
            secret scan · dependency review · build · E2E smoke (Playwright) · bundle-size budget
main → build once → images signed (cosign) + SBOM + SLSA provenance → deploy dev
release tag → staging (automated) → E2E + smoke + load baseline → manual approval (2 people)
          → production canary 5% → automated analysis (error rate, latency, SLO burn) 30 min
          → 25% → 100%; web assets published with signed release manifest
```

- **Migrations** run as a pre-deploy Job (expand phase) — must be backward compatible with
  the currently running version; contract migrations only in a later release.
- **Rolling deployments** with `maxUnavailable: 0`; readiness gates; realtime pods drain
  with jittered reconnect instructions (see [realtime.md §5](realtime.md)).
- **Rollback**: redeploy previous image digest (one command, < 5 min); database changes are
  expand-only so rollback never needs a down-migration; feature flags for kill-switches.
- Web client: old asset versions kept 30 days so open tabs keep working; clients check
  `/version` and prompt reload on incompatible protocol versions.

## 4. Infrastructure as code

Terraform (modules per component, remote state with locking, plan on PR, apply via CI with
OIDC role); Helm charts for services; Argo CD optional later. Drift detection nightly.

## 5. Configuration

`.env.example` in each service documents every variable (no values). Production config from
ConfigMaps (non-secret) + External Secrets (secret). Config schema validated at boot.

### Settings the load tests fixed (docs/capacity.md §4)

- **Realtime pods**: `terminationGracePeriodSeconds` ≥ 50 (drain window 30 s + shutdown timeout
  45 s); `RLIMIT_NOFILE` above `MAX_CONNECTIONS` + 1,000; size the realtime tier **N+1** — the
  pods left after one fails must hold its sockets (a full survivor refuses upgrades with 503 and
  clients retry for tens of seconds).
- **Listen backlog**: `LISTEN_BACKLOG` (API and realtime, default 4096) only takes effect up to
  the node's `net.core.somaxconn`; set the pods' namespaced sysctl `net.core.somaxconn=4096`.
- **Rolling deploys of the realtime tier**: one pod at a time (`maxUnavailable: 1`,
  `maxSurge: 1`), so each wave of reconnects is one pod's sockets spread over 30 s.
- **API capacity for a pod crash**: a crash sends one pod's clients back at once (no drain hint);
  every reconnect costs a ticket, a sync and catch-up. Keep API CPU headroom for one realtime
  pod's sockets reconnecting within ~15 s, or keep realtime pods small (10–15k sockets): on the
  test machine (≈ 300 reconnects/s next to traffic) a 10,000-socket crash slowed connected
  users' sends to p95 ≈ 9 s for ≈ 20 s. Ticket admission (`REALTIME_TICKETS_PER_SECOND`, off by
  default) does not help with that and slows recovery (capacity.md §4).

### Settings the security review added (docs/security/review.md)

- **Breached-password mirror** (`PWNED_PASSWORDS_URL`, required in production): the Pwned
  Passwords range files (16⁵ objects named by SHA-1 prefix, refreshed monthly with the official
  downloader) served read-only from object storage through an internal endpoint
  (`GET <url>/range/<prefix>`). Internal only — the API is its only client; it fails open, so
  alert on `auth.breach_check_unavailable` warnings.
- **Link-preview fetcher isolation** (F-05): run the fetcher as its own deployment whose only
  egress is an HTTP egress proxy enforcing the same deny-list; the API pods get no general
  internet egress (NetworkPolicy).
- **Realtime pod crash** (F-14): size API headroom and realtime pod sockets from the staging
  measurements before beta (capacity.md §4).

## 6. Hardening baseline

Pods: non-root, read-only root FS, drop all capabilities, seccomp `RuntimeDefault`, no
service-account token unless needed, resource requests/limits, PodDisruptionBudgets.
Cluster: private API endpoint, NetworkPolicies default-deny, image signature admission
policy, GuardDuty/EKS runtime monitoring, CIS benchmark checks.
