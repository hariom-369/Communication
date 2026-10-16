# Kubernetes manifests

Generated per environment from typed definitions (`src/manifests.ts`), not hand-edited YAML:

```
pnpm --filter @tessera/k8s build
pnpm --filter @tessera/k8s render --values <values.json> --out <dir>   # writes <dir>/<env>.yaml
```

`values.json` holds only what this repository does not decide (domain, registry and image
digest, region, VPC and data-subnet CIDRs, bucket names, certificate ARN, admin identity
provider) — the Terraform root's `k8s_values` output plus the release digest. The files in
`test-values/` are fixtures for the tests and CI, not real environments.

Checks: `policy.test.ts` (hardening baseline, network isolation, rollout settings, F-05 isolation
of the link fetcher), `config.test.ts` (each service's own configuration loader accepts the
rendered production settings), `alerts.test.ts` (every alert has a severity and a runbook and
uses only exported metrics), and CI validates the rendered YAML against the Kubernetes 1.37
schemas (`kubernetes-validate`). Cluster prerequisites (AWS Load Balancer Controller, External
Secrets Operator, cert-manager, Prometheus Operator, metrics-server) are listed in
docs/deployment.md §4.
