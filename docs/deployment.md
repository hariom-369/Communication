# Deployment architecture

Status: **as built in Phase 17, not yet deployed** (no cloud account is part of this
repository) · Decisions: ADR-023, ADR-054. What runs where, how a release is built and shipped,
and what an operator must do once per environment. Everything below is in the repository and
checked by tests or CI; what has not been run against a real account is said so.

## 1. Environments

| Env | Purpose | Data | Access |
|---|---|---|---|
| local | developer machines | docker compose (infra/docker): Postgres, Valkey, MinIO, Mailpit; LiveKit and coturn binaries | developers |
| staging | production-like: release candidates, load and DR tests, external assessments | synthetic only (never production personal data) | engineering, QA, assessors |
| production | users | real | on-call via just-in-time break-glass; the deploy workflow |

Separate AWS accounts per environment, separate KMS keys, no network path between them.

## 2. Topology (ap-south-1, 3 AZs) — infra/terraform, infra/k8s

```
app.<domain> ─ CloudFront (WAF) ─▶ public ALB (admits CloudFront only)
                                    ├─ /api/* ─▶ api           (user API, also the singleton jobs)
                                    ├─ /rt/*  ─▶ realtime      (WebSocket gateway)
                                    └─ /*     ─▶ web (nginx)   (signed build; /sfu → LiveKit signalling)
admin.<domain> ─ access proxy ─▶ internal ALB ─┬─ /admin/v1/* ─▶ admin-api
                                               └─ /*          ─▶ admin-web (nginx)
api ─▶ link-fetcher (isolated: no data stores, no keys, egress to public 443 only; F-05)
turn.<domain>, media nodes (public addresses, host network): coturn, LiveKit — UDP media direct
RDS PostgreSQL 17 Multi-AZ · ElastiCache Valkey 8 Multi-AZ (TLS, auth) · S3 (attachments,
breached-password mirror, audit exports) · KMS · Secrets Manager · AWS Backup → ap-south-2
```

**One origin per app.** The web app's CSP allows `connect-src 'self'` (plus the media bucket),
and its session cookie is `__Host-`: the API, the realtime gateway and the SFU's signalling
therefore sit on the app's origin, routed by path — as `vite preview` routes them for the
end-to-end tests. The admin console is the same on its own origin.

**Workloads** (namespace `tessera`, Pod Security "restricted"; manifests generated from typed
definitions, `infra/k8s`):

| Deployment | Image, command | Replicas (staging / production) |
|---|---|---|
| api | `tessera-api`, `dist/server.js` | 2–6 / 3–30 (HPA on CPU) |
| admin-api | `tessera-api`, `dist/admin-server.js` | 2 / 2 |
| link-fetcher | `tessera-api`, `dist/fetcher-server.js` | 2–4 / 2–8 |
| realtime | `tessera-realtime`, `dist/server.js` | 3–6 / 4–24, 10k / 12k sockets per pod (N+1, F-14) |
| web | `tessera-web` (nginx) | 2–4 / 3–12 |
| admin-web | `tessera-admin-web` (nginx) | 2 / 2 |
| migrate-&lt;release&gt; (Job) | `tessera-api`, `dist/cli/migrate.js` | once per release |
| coturn, livekit (`tessera-media`, host network) | upstream images | 2 / 3 each, one per media node |

Every pod: non-root (65532), read-only root filesystem, no capabilities, seccomp
`RuntimeDefault`, no service-account token, CPU and memory requests and a memory limit,
startup/readiness/liveness probes on the internal health port, a PodDisruptionBudget, spread over
zones. Network policy is default-deny with one policy per workload (enforced by the VPC CNI).
`infra/k8s/src/policy.test.ts` enforces all of this on the rendered output.

**Images** (`infra/images`): the API and realtime images are built with `pnpm deploy --prod`
onto distroless Node 22 (no shell, non-root); the web images are nginx-unprivileged serving the
build with a configuration generated from the headers the build wrote
(`dist/security-headers.json`, from the same `productionHeaders` `vite preview` uses), so the CSP,
caching and SPA fallback of production are those the end-to-end tests run against
(`E2E_WEB_SERVER=nginx` runs the suite through that nginx configuration).

## 3. CI/CD

```
pull request → CI (.github/workflows/ci.yml): format, lint, typecheck, build, unit, integration,
               end-to-end (Chromium, production build, real services), OpenAPI and route-matrix
               drift, secret scan, OSV (npm + Cargo), dependency review, CodeQL, cargo deny,
               images built and run read-only as non-root, manifests rendered and validated
               against the Kubernetes schemas, promtool on the alert rules, terraform validate
tag vX.Y.Z  → release (.github/workflows/release.yml, protected environment): the signed web
               release; five images with BuildKit SLSA provenance and SBOM attestations; Trivy
               (fixable HIGH/CRITICAL blocks the release); CycloneDX SBOMs; keyless cosign
               signatures and SBOM attestations; manifests of both environments rendered with
               the image digests; a GitHub release with all of it
deploy      → deploy (.github/workflows/deploy.yml, manual, per environment, approvals on
               production): verify every image's signature against the release workflow's
               identity, apply "prepare" (config, secrets, policies, services, the migration
               Job), wait for the migration, apply the workloads, wait for every rollout
```

- **Migrations** run as the release's Job before any workload changes; they are expand-only, so
  the running version keeps working; readiness accepts migrations newer than the code (a
  rollback is safe). The Job holds only the migrator's database credentials.
- **Rollouts**: API and web tiers never drop below their replica count; the realtime tier one pod
  at a time with a 30 s drain (clients reconnect elsewhere with jitter).
- **Rollback**: deploy the previous release (its manifests are in its GitHub release); never a
  down-migration (ops/runbooks/deploy-rollback.md).
- **Not built**: automated canary analysis (watch the SLO alerts for 30 minutes after a production
  rollout instead), Argo CD, nightly drift detection.

## 4. Infrastructure as code and bootstrap

`infra/terraform` (one root, applied per account; README there) creates the network, EKS, the data
stores, buckets, edge, backups and the deploy role; its output `k8s_values` is the input of
`infra/k8s`. Checked here: HCL syntax and a structural check (`check.py`); CI runs `fmt`,
`init -backend=false` and `validate`. **It has not been planned or applied against an AWS
account.** Once per environment a cluster administrator installs the AWS Load Balancer
Controller, External Secrets Operator, cert-manager, external-dns, Prometheus Operator,
metrics-server and an image-signature admission policy, applies `<env>-0-namespaces.yaml`,
creates the secrets (ops/runbooks/secrets.md) and runs `ops/db/roles.sql`.

## 5. Configuration

Non-secret settings are ConfigMaps rendered from code (`infra/k8s/src/manifests.ts`); secrets come
from AWS Secrets Manager through External Secrets (contract in ops/runbooks/secrets.md). Every
service validates its configuration at boot and refuses insecure production settings;
`infra/k8s/src/config.test.ts` boots each service's loader on the rendered production settings.

**Database roles** (`ops/db/roles.sql`): `tessera_migrator` owns the schema and is used only by the
migration Job; the API runs as `tessera_app` (rows only, no DDL; the audit log is insert-only at
the privilege level too); the realtime gateway as `tessera_realtime` (reads sessions, memberships
and blocks only); operators and the restore drill as `tessera_readonly`. The web end-to-end suite
passes with the services on these roles (`E2E_DB_ROLES=1`).

### Settings the load tests fixed (docs/capacity.md §4)

- **Realtime pods**: `terminationGracePeriodSeconds` 90 (drain 30 s + shutdown timeout 45 s);
  `MAX_CONNECTIONS` 10–12k per pod; N+1 sizing — the pods left after one fails hold its sockets.
- **Listen backlog**: `LISTEN_BACKLOG` (4096) only takes effect up to `net.core.somaxconn`, which a
  restricted pod cannot set; the nodes set it (launch template user data, infra/terraform).
- **Rolling deploys of the realtime tier**: `maxUnavailable: 1`, `maxSurge: 1`.
- **API capacity for a pod crash** (F-14): keep CPU headroom for one realtime pod's sockets
  reconnecting within ~15 s; measure in staging before beta.

### Settings the security review added (docs/security/review.md)

- **Breached-password mirror** (`PWNED_PASSWORDS_URL`, required in production): the Pwned
  Passwords range files in the `-pwned` bucket, readable only through the VPC's S3 endpoint;
  monthly refresh in ops/runbooks/breached-password-mirror.md; alert on fail-open.
- **Link-preview fetcher isolation** (F-05, built): `LINK_PREVIEW_FETCHER_URL`/`_TOKEN` required in
  production; the API never connects to user-supplied URLs itself.

## 6. Hardening baseline

Pods: as in §2. Cluster: private node subnets, IMDSv2 with hop limit 1 (pods cannot reach node
credentials), KMS-encrypted Kubernetes secrets, API-only access entries, the deploy role scoped to
the application namespaces, NetworkPolicy enforcement, control-plane audit logs (180 days),
image-signature admission (bootstrap). Edge: TLS 1.2+ (TLS 1.3 policy on the load balancers), WAF,
load balancers reachable only from CloudFront or the access proxy. Data: encryption at rest with
customer keys, TLS required, no public endpoints, deletion protection in production.
