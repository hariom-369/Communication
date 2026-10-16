# Runbook — deploys and rollback

Alert: `ServiceTargetDown` (page). Also used for any bad release.

## How a release goes out (docs/deployment.md §3)

1. The release workflow builds the four images, the SBOMs and provenance, signs them, and renders
   the manifests with the image digests (`.github/workflows/release.yml`).
2. The migration Job `migrate-<release>` runs first; migrations are expand-only, so the running
   version keeps working against the new schema.
3. Rolling updates: API and web tiers with no unavailable pods; realtime one pod at a time (each
   pod drains for 30 s, telling its clients to reconnect elsewhere with jitter).
4. Production only after the same release has run in staging, with two approvals on the GitHub
   `production` environment. Automated canary analysis is not built yet: watch the SLO alerts for
   30 minutes after the rollout and roll back on any page.

## Roll back

The previous release's rendered manifests are attached to its GitHub release. Re-apply them:

```
kubectl apply -f production.yaml        # from the previous release
kubectl -n tessera rollout status deploy/api deploy/realtime deploy/web --timeout=15m
```

Or per deployment: `kubectl -n tessera rollout undo deploy/<name>`. Never run a down-migration:
the schema change of the bad release stays and is contracted later. The web app: browsers keep
the release they verified; a rollback ships as a new signed release (release-signing-key.md).

## A target is down

1. `kubectl -n tessera get pods -o wide`; `kubectl describe pod` for scheduling and probe
   failures; `kubectl logs --previous` for crashes. Boot failures log a single JSON line
   (`event` ends in `.boot_failed`) naming the invalid setting — configuration errors are
   refused at boot by design.
2. Image pull failures: the image admission policy refused an unsigned image, or the digest is
   wrong — never bypass the policy; re-run the release.

## Resolved when

All targets up, rollouts complete, no SLO alert for 30 minutes.
