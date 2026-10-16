# Runbook — floods and denial of service

Layers: AWS Shield Standard and CloudFront absorb volumetric attacks; WAF (managed rules, a
per-address rate limit of 6,000 requests per 5 minutes) filters at the edge; the API's own
per-route, per-account and per-address limits; the realtime gateway's ticket, per-user
connection and frame limits. Media (TURN/SFU) nodes are directly exposed on UDP.

1. **See it:** CloudFront and WAF metrics (requests, blocked), API `tessera_http_requests_total`
   by route and status (429 is the limits working), realtime `upgrades_total{result}`.
2. **Application-layer flood on a route:** add a WAF rule for its pattern (path, header,
   country if needed) in count mode, check, then block. Lower the rate-based rule temporarily —
   remember CGNAT: many real users share addresses in India (docs/security.md §7).
3. **Sign-up / sign-in abuse:** the routes fail closed when limits are hit; for credential
   stuffing see account-takeover.md.
4. **UDP floods on media nodes:** Shield Standard covers common reflection attacks; scale the media
   node group, and if needed disable group calls with the `group_calls` kill switch (1:1 calls fall
   back to TURN, which is also on these nodes).
5. Consider Shield Advanced for production (cost decision, recorded in launch-readiness.md).
