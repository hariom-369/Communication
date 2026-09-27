# Observability

Status: PROPOSED · Decision: ADR-026

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
