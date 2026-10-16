# Observability

Status: metrics, alert rules and health endpoints **as built (Phase 17)**; traces, the log
pipeline and client telemetry are deployment work not built yet · Decision: ADR-026

## As built

- **Metrics** (`prom-client`, `packages/platform/src/metrics.ts`): every service serves
  Prometheus text at `/metrics` on its internal health port (never a public one), scraped by
  PodMonitors (infra/k8s). Labels are bounded by construction (route ids, job names, enum
  results). Series:
  - process and Node.js defaults (`tessera_process_*`, `tessera_nodejs_*`: CPU, memory, file
    descriptors, event-loop lag, GC);
  - API and admin API: `tessera_http_requests_total{route,method,status_class}`,
    `tessera_http_request_duration_seconds{route,method}` (route = route id, `unmatched` for
    unknown paths — raw paths never become labels);
  - periodic jobs: `tessera_job_runs_total{job,result=ok|failed|skipped}`,
    `tessera_job_duration_seconds{job}`, `tessera_job_last_success_timestamp_seconds{job}`;
  - degraded controls: `tessera_breach_check_unavailable_total`,
    `tessera_rate_limit_store_errors_total`, `tessera_link_previews_total{result}`,
    `tessera_notify_queue_oldest_due_seconds`;
  - realtime: `tessera_realtime_connections`, `tessera_realtime_upgrades_total{result}`,
    `tessera_realtime_closes_total{code}`, `tessera_realtime_events_delivered_total{type}`,
    `tessera_realtime_auth_failures_total`;
  - link fetcher: `tessera_fetcher_requests_total{result}`.
- **Alert rules** (`infra/monitoring/alerts.yaml`, also rendered as a PrometheusRule): the SLOs of
  §3 as multi-window burn-rate and latency alerts, realtime acceptance, background jobs (failing,
  stalled), push queue age, and the controls that fail open. Every alert has a severity (`page` or
  `ticket`) and a runbook in `ops/runbooks/`; `infra/k8s/src/alerts.test.ts` checks that, and that
  every metric and route an alert uses exists; CI runs `promtool check rules`.
- **Logs**: structured JSON with the field allow-list (§4) on stdout; shipping (Fluent Bit → Loki
  or CloudWatch, in India) is a deployment step.
- **Not built yet**: OpenTelemetry traces, error tracking, client telemetry, Grafana dashboards
  (the alert expressions are the starting queries), the canary-secret log test (§4).

## 1. Signals

| Signal | Tooling |
|---|---|
| Traces | OpenTelemetry SDK → OTel Collector → Tempo (or AWS X-Ray) |
| Metrics | OTel/Prometheus exposition → Prometheus (AMP) → Grafana |
| Logs | pino JSON → stdout → Fluent Bit → Loki (or CloudWatch/OpenSearch) — in India region |
| Errors | Sentry-compatible (self-hosted or EU/IN-resident) with scrubbing |
| Client telemetry | web vitals, JS errors (scrubbed), call quality stats — opt-out |

## 2. Metrics catalogue (SLIs in bold)

- Users: active users (DAU/MAU from aggregated events), **concurrent WebSockets**, devices.
- Messaging: **messages/s submitted**, **submit→ack latency**, **ack→delivered latency**
  (online recipients), mailbox size, retention sweeper lag, epoch-conflict rate.
- Calls: setup success rate, setup time, relay ratio, estimated MOS, SFU rooms/participants.
- API: **request latency (p50/p95/p99) per route**, **error rate (5xx) per route**, 4xx by code, rate-limit rejections.
- Data stores: DB query latency, connections, replication lag, locks, bloat; Valkey
  latency/memory/evictions; queue depth and age; S3 errors; storage usage by bucket.
- Infra: CPU, memory, pod restarts, node saturation, bandwidth (CDN, TURN, SFU).
- Security: auth failures, MFA failures, new-device links, suspicious-login actions,
  CSP reports, WAF blocks, admin elevated sessions.

## 3. SLOs (initial) and alerting

| SLO | Target | Alert (multi-window burn rate) |
|---|---|---|
| Message submit availability | 99.9% | 2% budget in 1 h (page), 5% in 6 h (ticket) |
| Submit→ack p95 | < 250 ms | p95 > 400 ms for 10 min |
| Realtime connection success | 99.5% | < 98% for 5 min |
| API availability | 99.9% | burn-rate |
| Queue age (notifications) | < 30 s p95 | > 2 min for 10 min |

Pages go to on-call via PagerDuty/Opsgenie; each alert links to a runbook in `ops/runbooks/`.

## 4. Logging rules (enforced in code review + tests)

- **Allow-list serializers**: log objects are built from typed `LogFields`; unknown fields dropped.
- Never logged: message ciphertext or plaintext, passwords, session tokens, cookies,
  `Authorization` headers, recovery codes, OTPs, private keys, backup keys, KeyPackages,
  file names, search queries (except aggregated), email bodies, push payloads.
- IPs logged in security/ICT logs (CERT-In requirement, 180 days), not in app debug logs.
- User IDs allowed in logs (needed for support/security) — access to logs is restricted
  and audited.
- A CI test runs the app with canary secrets and asserts they never appear in captured logs.

## 5. Health endpoints

`/livez` (process alive — no dependencies), `/readyz` (DB, Valkey reachable; migrations at
expected version; draining=false), `/startupz`. Not exposed publicly (internal port).
