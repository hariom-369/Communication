# Runbook — realtime gateway

Alerts: `RealtimeConnectionSuccessLow` (page), `RealtimeSlowConsumersHigh` (ticket),
`FileDescriptorsNearLimit` (ticket).

**User impact.** Clients cannot (re)connect: no live delivery, typing or presence. Messages are
still accepted by the API and arrive on the next sync, so the app degrades to slower delivery.

## Confirm

1. Refusals by reason: `sum by (result) (rate(tessera_realtime_upgrades_total[5m]))`.
   - `full` — pods at `MAX_CONNECTIONS`: the tier is too small, or a pod died and its sockets
     moved (N+1 sizing, docs/capacity.md §4).
   - `draining` — a rollout; expected for about 30 s per pod.
   - `forbidden_origin` — clients on a wrong origin (misrouted CloudFront behaviour?) or probing.
2. Sockets per pod: `tessera_realtime_connections` by `pod`; restarts:
   `kubectl -n tessera get pods -l app.kubernetes.io/name=realtime`.
3. Ticket failures show at the API: route `realtime.ticket` 5xx/429 in
   `tessera_http_requests_total`; `tessera_realtime_auth_failures_total` rising means tickets
   expire before use (clock skew, Valkey latency).
4. Slow consumers (`code="1013"`): clients that cannot keep up; usually a network event on the
   client side or a pod with saturated CPU (event-loop lag).

## Mitigate

- `full`: scale out now (`kubectl -n tessera scale deploy realtime --replicas=<n+2>`; the HPA
  follows), then fix the HPA minimum. Keep pods at 10–15k sockets (F-14).
- A crash loop: check the last logs of the previous container (`kubectl logs --previous`) and
  roll back if it began with a deploy.
- File descriptors near the limit: the node's container runtime limit is below
  `MAX_CONNECTIONS` + 1,000 — lower `MAX_CONNECTIONS` for the pods (config map) and fix the node
  group's limit (infra/terraform).

## Resolved when

Upgrade acceptance above 99.5 % for 15 minutes; sockets spread evenly over pods.
