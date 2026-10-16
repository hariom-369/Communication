# Runbook — object storage misconfiguration

Buckets (infra/terraform/modules/storage): `-media` (attachments: ciphertext only, private,
presigned access), `-pwned` (readable only through the VPC endpoint), `-audit` (Object Lock).
All have Block Public Access on; the media bucket refuses non-TLS requests.

Signals: AWS Config / Security Hub findings on public access or policy changes, CloudTrail
`PutBucketPolicy`, `PutPublicAccessBlock`, `DeleteBucketPolicy`; browsers failing uploads
(CORS) show up as `media.*` 4xx in the API metrics.

1. **Public access opened:** re-apply Terraform (`terraform apply -target=module.storage`)
   — it restores the access block and policies. Attachments are end-to-end encrypted, so a
   public media bucket leaks ciphertext and metadata (object sizes, times), not content; still a
   security incident (incident-response.md): who changed it, what was listed or read
   (S3 server access logs / CloudTrail data events).
2. **Uploads fail after a domain change:** the CORS rule names the app origin; update
   `app_origin` and apply.
3. **Breached-password checks failing (403):** the `-pwned` policy's `aws:SourceVpce` no longer
   matches the endpoint (endpoint recreated) — apply Terraform; see breached-password-mirror.md.
