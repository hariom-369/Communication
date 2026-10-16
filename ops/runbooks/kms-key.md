# Runbook — KMS key disabled, scheduled for deletion, or compromised

Keys (infra/terraform): `*-data` (RDS, Valkey, Secrets Manager entries it encrypts), `*-storage`
(attachments, audit exports), `*-secrets` (Kubernetes secrets envelope), `*-backup` and its DR copy.

**Disabled or pending deletion** (CloudTrail `DisableKey` / `ScheduleKeyDeletion`; an AWS Config
rule alerts): the dependent service fails at its next key use — RDS cannot start or restore,
S3 objects cannot be read, new Kubernetes secrets cannot be written. Re-enable at once
(`aws kms enable-key`, `aws kms cancel-key-deletion`) — deletion has a 30-day window. Then find
who did it (CloudTrail) and treat an unexpected change as a security incident.

**Suspected compromise of the key material** is not something KMS keys suffer in the usual sense
(material never leaves KMS); what is compromised is a principal allowed to use the key. Revoke that
principal's access (IAM, key policy), rotate its credentials, and review CloudTrail `Decrypt`
calls for the period. Rotating the key (`enable-key-rotation` is on, yearly) does not re-encrypt
existing data; to retire a key, re-encrypt (RDS: snapshot copy with the new key and restore;
S3: copy objects in place with the new key) before disabling the old one.
