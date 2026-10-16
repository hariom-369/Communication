# Runbook — link-preview fetcher

Alerts: `LinkFetcherUnauthorizedRequests` (ticket), `LinkPreviewsUnavailable` (ticket).

The fetcher (`dist/fetcher-server.js`, deployment `link-fetcher`) fetches channel link previews
for the API, isolated by design (security review F-05): no database, Valkey or keys, only its
bearer token; its NetworkPolicy admits only API pods and lets it reach only public addresses on
443. It has no state; restarting it is always safe.

**User impact.** Posts are published without a preview. Nothing else depends on it.

## Unauthorized requests

Someone other than the API reached the fetcher, or the tokens differ.
1. Token drift after a rotation: `LINK_PREVIEW_FETCHER_TOKEN` (secret `api`) and `FETCHER_TOKEN`
   (secret `link-fetcher`) must be the same value — [secrets.md](secrets.md). Restart both
   deployments after fixing the secret.
2. Otherwise treat as a security event: the NetworkPolicy should make it impossible. Check the
   policy is applied (`kubectl -n tessera get networkpolicy link-fetcher -o yaml`), look for new
   pods in the namespace, and open an incident ([incident-response.md](incident-response.md)).

## Previews unavailable

1. `kubectl -n tessera get pods -l app.kubernetes.io/name=link-fetcher`; `busy` results
   (`tessera_fetcher_requests_total{result="busy"}`) mean the concurrency limit is hit: scale out.
2. Abuse (many links to slow sites) shows as `timeout` results; the kill switch `link_previews`
   in the admin console stops all previews while it is investigated.

## Never

Do not give the fetcher database, Valkey or cloud credentials, and do not widen its egress to
private ranges to "fix" a preview: that undoes the isolation.
