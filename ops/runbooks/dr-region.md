# Runbook — regional failover (ap-south-1 → ap-south-2)

Targets (docs/disaster-recovery.md §1): full region loss → RPO ≤ 15 min, RTO < 4 h during beta.
The DR region holds (infra/terraform, not yet applied anywhere): **replicated RDS automated
backups** (snapshots plus transaction logs, kept 7 days — point-in-time restore *in ap-south-2*, RPO
of minutes), AWS Backup copies (daily for 35 days, monthly for a year), and **replicated
attachments** (S3 replication with a 15-minute replication-time objective and lag metrics). Nothing
runs there: it is cold, so the RTO is dominated by bringing up the cluster (step 2).

Not replicated yet: the secrets (step 4 recreates them), the breached-password mirror (re-run the
download into a DR bucket) and the audit-export bucket.

## Procedure

1. Declare a severity 1 incident (incident-response.md); freeze deploys; status page.
2. In the DR account/region: `terraform apply -var-file=envs/<env>-dr.tfvars` with
   `region = "ap-south-2"` creates network, cluster, Valkey and buckets (the state backend of
   that root must not live in the failed region).
3. Restore the database in the DR region to the latest restorable time from the replicated
   automated backups (`aws rds restore-db-instance-to-point-in-time --source-db-instance-automated-backups-arn …
   --use-latest-restorable-time`), or from the DR vault if those are unavailable, into the new
   subnet group; verify it (dr-restore.md, step 3). Point `MEDIA_S3_BUCKET` at the `-media-dr`
   bucket.
4. Secrets: create them in the DR region (they are not replicated automatically yet); bootstrap
   the cluster (infra/terraform README) and deploy the current release with the Deploy workflow
   against the DR cluster.
5. DNS: point `origin.<domain>` at the DR load balancer (external-dns does it once the ingress
   exists) and the CloudFront origin follows; TURN/SFU names follow their nodes.
6. Clients reconnect, resync from their cursors and re-send what they had queued (idempotent).
   Messages accepted after the restore point and not yet delivered are lost from the server;
   senders still have them.
7. Afterwards: reconcile, plan the failback (the same procedure in reverse once the region is
   back), incident review.
