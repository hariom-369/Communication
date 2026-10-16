# Runbook — API errors and latency

Alerts: `MessageSubmitErrorBudgetBurnFast` (page), `MessageSubmitErrorBudgetBurnSlow` (ticket),
`MessageSubmitLatencyHigh` (page), `ApiErrorBudgetBurnFast` (page), `EventLoopLagHigh` (ticket).

**User impact.** Sends fail or hang: the web app keeps messages in its outbox and retries with
the same idempotency key, so nothing is lost while it lasts, but users see "sending…".

## Confirm

1. Which routes: `sum by (route) (rate(tessera_http_requests_total{service="api",status_class="5xx"}[5m]))`.
2. Which pods: add `pod` to the `by`; one pod → step 3 of Mitigate; all pods → a dependency.
3. Logs: `event="http.unhandled_error"` (our bug; each has an `errorId`) and
   `event="http.dependency_error"` (PostgreSQL / Valkey / S3). Error ids are what users can quote.
4. Database: RDS Performance Insights (top SQL, lock waits), connections vs
   `DATABASE_POOL_MAX` × pods; `postgres.idle_client_error` warnings mean failovers.
5. Latency without errors: `tessera_nodejs_eventloop_lag_p99_seconds` per pod (CPU-bound pod),
   HPA at max (`kubectl -n tessera get hpa api`), node pressure.

## Mitigate

- **Recent deploy?** Roll back first, investigate after ([deploy-rollback.md](deploy-rollback.md)).
- **Database saturated:** scale the API down is wrong (clients retry harder); instead stop the
  background jobs' load if they are the cause (they run under advisory locks — see
  [background-jobs.md](background-jobs.md)), kill runaway queries
  (`SELECT pg_cancel_backend(pid)` for the offending `application_name`), and fail over or scale
  the instance class if CPU-bound.
- **One bad pod:** `kubectl -n tessera delete pod <pod>` (the PDB keeps the rest serving).
- **CPU-bound everywhere:** raise the HPA maximum (`kubectl -n tessera patch hpa api …`) and check
  whether a realtime pod crash is sending reconnect storms (capacity.md §4; [realtime.md](realtime.md)).
- **Feature at fault:** kill switches in the admin console (four eyes): `link_previews`,
  `group_calls`, `billing`.

## Resolved when

Error ratio back under 0.1 % for 30 minutes and send p95 under 250 ms. Write the incident
review if the page fired ([incident-response.md](incident-response.md)).
