# Phase 17 report — Production deployment

**Status: GREEN locally as code; not deployed; launch gates open.** Verified 2026-10-16.
Everything production needs from this repository is built and checked here: the isolated
link-preview fetcher, metrics and alert rules, container images, Kubernetes manifests, the
release and deploy pipelines, Terraform for the AWS accounts, least-privilege database roles,
runbooks, and two disaster-recovery drills. **Nothing has been applied to a cloud account** (none
is part of this repository), and the launch gates of [prd.md §9](../prd.md) that need people
outside it — the external cryptographic review, legal sign-off, a named grievance officer and an
incident-response exercise — are **not met**. The list is in
[launch-readiness.md](../launch-readiness.md).

## Results

| Gate | Result |
|---|---|
| Format, lint, typecheck, build | pass |
| Unit tests | **723 TypeScript** (api 426, web 152, ui 65, k8s 35, platform 18, shared 9, load 8, realtime 4, validation 3, admin 3) + **78 Rust** — new: metrics registry and `/metrics`, HTTP and job metrics, fetcher configuration, migrate configuration, rendered-manifest policy (restricted pods, network policy, probes, PDBs, secrets only from External Secrets), every service's configuration loader booted on the rendered production settings, alert rules referencing real metrics |
| Integration (real PostgreSQL + Valkey + S3-compatible store + coturn) | **251 passed** (api 230, realtime 21); 2 skipped (IPv6 TURN without IPv6 here; opt-in channel scale test) — new: the API through the isolated fetcher (and a fetcher outage not cached as "no preview"), the fetcher's authentication and limits, audit-chain verification across pages with a tampered row, realtime metrics, **resync after a Valkey subscription loss (F-15)** |
| End-to-end, user app (Chromium, production build, real services) | **60 passed (1 skipped: opt-in call load test) in each of 3 consecutive runs** |
| End-to-end, admin console | **6 passed in each of 3 consecutive runs** |
| End-to-end through the production nginx configuration (`E2E_WEB_SERVER=nginx`) | **60 passed (1 skipped)** — the full suite, with the web build made for the test media origin |
| End-to-end with least-privilege database roles (`E2E_DB_ROLES=1`: migrations as `tessera_migrator`, API as `tessera_app`, realtime as `tessera_realtime`) | **60 passed (1 skipped)** |
| Mutation checks | every new guard fails its test when removed: fetcher token check, response validation, size and concurrency limits (4), the API's compose wiring to the remote fetcher, the 10 manifest policies, audit-chain tamper detection, the Valkey resync |
| OpenAPI / route matrix | no drift |
| `pnpm audit` / gitleaks | no known vulnerabilities / no leaks (full history) |
| `cargo deny --locked check` | advisories, bans, licences, sources ok — one reviewed exception: RUSTSEC-2026-0173, an unmaintained compile-time macro crate reached through OpenMLS's crypto provider, no vulnerability, no upgrade available |
| Kubernetes manifests | staging and production rendered and valid against the Kubernetes 1.34 schemas, the EKS version Terraform sets (`kubernetes-validate --strict`; CI pinned to that version in this phase). Custom resources (ExternalSecret, PodMonitor, PrometheusRule, Certificate) have no schema there and are covered by the policy tests only |
| Alert rules | `promtool check rules`: 17 alerts, recording rules valid |
| Workflows | actionlint clean (ci, release, deploy, fuzz, codeql) |
| Terraform | 6 modules and the root parse; structural check (`check.py`) 0 errors; CI runs `terraform fmt`, `init -backend=false`, `validate` (not runnable here) |
| Images | **not built here** (no Docker daemon in this environment): the API image's `pnpm deploy --prod` bundle was assembled as in its Dockerfile and its migrate, API and fetcher entrypoints started from it, and the web apps were served through the generated nginx configuration (E2E above); CI builds all four images and runs them read-only as non-root |

## Delivered

- **Isolated link-preview fetcher (F-05)**: `dist/fetcher-server.js` from the API image, with no
  database, Valkey, object store or keys; bearer-token authenticated, concurrency-limited; the
  API calls it and validates its answers as untrusted; required in production. Network policy:
  only the API in, only public port 443 out.
- **Observability**: Prometheus metrics on every service's internal health port (HTTP by route
  id, background jobs, realtime connections and deliveries, queue age, degraded controls);
  SLO-based alert rules with a runbook for each ([observability.md](../observability.md)).
- **Images** (`infra/images`): distroless Node 22 for API and realtime; nginx-unprivileged for
  the two web apps, configured from the headers the build emits, so production serves exactly
  what the end-to-end suite tested.
- **Kubernetes** (`infra/k8s`): manifests generated from typed values (namespaces, prepare with
  the migration Job, workloads), one origin per app behind the ALB, the media tier (coturn,
  LiveKit), External Secrets, network policies, PodMonitors and the alert rules; policy tests on
  the rendered output.
- **Release and deploy** (`release.yml`, `deploy.yml`): SBOMs, Trivy gate, BuildKit provenance,
  keyless cosign signatures, signature verification before deploy, migrations before workloads,
  GitHub OIDC to AWS; Dependabot for npm, Cargo, actions, images and Terraform; `cargo deny`.
- **Terraform** (`infra/terraform`): network, EKS, RDS and ElastiCache, buckets (media with
  replication to ap-south-2), edge (CloudFront, WAF, certificates), backups (locked vaults,
  copies and point-in-time replication to the DR region) and the deploy role.
- **Database roles** (`ops/db/roles.sql`): migrator, application, realtime and read-only roles;
  the audit log is insert-only at the privilege level.
- **DR** ([disaster-recovery.md](../disaster-recovery.md), [drill record](../dr-drills/2026-10-16.md)):
  `ops/dr/restore-drill.sh` with `verify-audit`; restore drill **passed**; Valkey-loss drill.
- **Runbooks** (`ops/runbooks`, 20): on-call, incident response with CERT-In and DPDP clocks,
  every alert, deploy and rollback, secrets and KMS, DDoS, account takeover, CSAM escalation,
  DR restore and region failover, release-signing key.
- **Launch readiness** ([launch-readiness.md](../launch-readiness.md)): the prd §9 gates with
  status, what staging must show, open findings and decisions.

## Findings fixed in this phase

| ID | Severity | Fix | Test |
|---|---|---|---|
| F-05 | medium | link-preview fetcher isolated as its own deployment | integration + unit, mutation-checked; manifest policy test |
| F-06 | medium | SBOMs, scanning, signing with verification at deploy, provenance, `cargo deny` (cluster admission policy, SLSA L3, reproducible builds and a transparency log remain open) | CI / release workflow, actionlint |
| F-15 | medium | **found by the Valkey-loss drill**: deliveries published while a realtime pod's Valkey subscription was down were lost and connected clients never caught up (3,902 of 12,000); the pod now asks its connections to reconnect with jitter when the subscription returns | integration test, mutation-checked; drill re-run: 0 missing |

F-14 (realtime crash headroom) is mitigated by sizing and stays open until measured in staging;
F-09 (risk-based challenges) stays open, before public beta.

## Problems found and fixed during the phase

- The realtime gateway's WebSocket path given as a full `wss://` URL was refused by the API's
  configuration — which showed that the CSP (`connect-src 'self'`) and the `__Host-` cookie
  require one origin per app. The topology was redesigned around path routing on one ALB.
- One image value could not serve four images; a namespace-scoped deploy role cannot create
  namespaces (split into a bootstrap file); NLB TLS and numeric health ports — designs corrected
  before anything was applied.
- Through nginx, the service worker refused the release because source maps and
  `security-headers.json` were 404 while the signed manifest pins every file; nginx now serves
  every built file. Also: `error_log stderr`, a 1 MiB proxied-body limit, writable temp paths.
- `pnpm deploy` failed on strict peer dependencies and needed the workspace `.npmrc` in the
  image build.
- The restore drill found that the read-only role could not back up (no SELECT on sequences),
  and that the audit-chain check loaded the whole log (now paged).
- The load harness under-counted catch-up recoveries (it skipped unseen conversations and
  tracked the highest seq); it now tracks contiguous seqs like the web client.
- A gate run lost its database midway because my local service script deleted PostgreSQL's
  lock file while the server was running; the script now checks first and the gate was re-run.

## Security implications

New attack surface is operational, not product: the fetcher service (authenticated, no data or
keys, egress-only), the metrics endpoints (internal health port only, no user data or labels
derived from user input), the CI/CD identity (OIDC, short-lived, deploy role limited to the
application namespaces) and the infrastructure itself (private subnets, IMDSv2 hop limit 1,
customer-managed keys, no public data endpoints). The supply-chain threats T-17/T-19/T-20 moved
from "not built" to built (threat-model §7). Logs and metrics carry no message content, tokens or
keys. The server still cannot decrypt messages; nothing in this phase touches the cryptography.

## Moved / not done

- Applying Terraform, the first release and deploy, and everything in launch-readiness §2
  (staging DR timings, region bring-up, Stage 2 load with headroom, 24-hour soak, 32-participant
  calls, TLS and header scan, external assessments S-13) → staging, before public beta.
- Legal sign-off (L-01..L-15), grievance-officer appointment, incident-response tabletop →
  outside engineering; tracked in launch-readiness.md.
- Image-signature admission policy as manifests, SLSA L3, reproducible builds, transparency log,
  service mesh, automated canary analysis, secrets replication to the DR region → open items in
  launch-readiness §3.
- Invite-code gate for a closed beta → decision before beta.

## Commit

The Phase 17 work is in the commits prefixed "Phase 17" on branch
`claude/trusting-goodall-55613i`; this report closes the phase and the implementation plan.
