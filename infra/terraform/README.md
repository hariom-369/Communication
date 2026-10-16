# Infrastructure (Terraform)

One root module, applied once per environment in its own AWS account (docs/deployment.md §1):

```
terraform init  -backend-config=envs/<env>.backend.hcl
terraform plan  -var-file=envs/<env>.tfvars -out plan
terraform apply plan
```

| Module | Creates |
|---|---|
| `network` | VPC over 3 AZs: public, private (nodes), data (no internet route), media (public addresses); NAT per AZ; S3 gateway and interface endpoints; flow logs (180 days) |
| `eks` | EKS with KMS-encrypted secrets, API-only authentication, NetworkPolicy enforcement in the VPC CNI; general and media node groups (IMDSv2 with hop limit 1, encrypted volumes, `net.core.somaxconn=4096`); Pod Identity roles for the API (attachments bucket) and External Secrets (this environment's secrets only); the GitHub OIDC deploy role, administering only the application namespaces |
| `data` | PostgreSQL 17 Multi-AZ (TLS forced, PITR 35 days, deletion protection in production, managed master password); Valkey 8 Multi-AZ with TLS and an auth token |
| `storage` | Attachments bucket (KMS, versioning, CORS for the app origin, abandoned uploads and deleted versions expire), breached-password mirror bucket (readable only through the VPC endpoint), audit export bucket (Object Lock, compliance mode) |
| `edge` | ACM certificates, WAF (AWS managed rules, per-address rate limit), CloudFront for `app.<domain>` in front of the public ALB, the ALB security groups (CloudFront only; admin: the access proxy only) |
| `backup` | AWS Backup: daily and monthly RDS recovery points, copied to the DR region, vault lock in production |

The output `k8s_values` is the input of `infra/k8s` (stored as the GitHub environment variable
`K8S_VALUES_<ENVIRONMENT>`; the release adds the version and image digests).

## Status

**Not applied anywhere yet** (no cloud account is part of this repository). Checked here: HCL
syntax, and `check.py` — module inputs and outputs wired consistently, required variables
given, `k8s_values` keys equal to what `infra/k8s` expects. CI runs `terraform fmt -check`,
`init -backend=false` and `validate` with the pinned provider. The first `plan` against a real
account is part of the staging bring-up (docs/launch-readiness.md).

## After apply: cluster bootstrap (cluster administrator, once)

1. Install with their upstream charts and documented IAM policies: AWS Load Balancer Controller,
   External Secrets Operator (with a `ClusterSecretStore` named `aws-secrets-manager`),
   cert-manager (a `ClusterIssuer` named `letsencrypt-dns`, Route 53 DNS-01), external-dns,
   Prometheus Operator (namespace `monitoring`), metrics-server, and an image signature
   admission policy for `<registry>/tessera-*` (cosign keyless, identity of
   `.github/workflows/release.yml`).
2. Apply `<env>-0-namespaces.yaml` from a release.
3. Create the secrets listed in [ops/runbooks/secrets.md](../../ops/runbooks/secrets.md) and the
   database roles ([ops/db/roles.sql](../../ops/db/roles.sql)).
4. Deploy with the Deploy workflow.
