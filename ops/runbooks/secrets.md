# Runbook — secrets

Secrets live in AWS Secrets Manager as JSON documents `tessera/<environment>/<name>`; External
Secrets Operator copies each into a Kubernetes Secret of the same name (infra/k8s). Nothing
secret is in the repository, the manifests, ConfigMaps or images (checked by
`infra/k8s/src/config.test.ts`).

## Contents (the contract the manifests rely on)

| Secret | Keys | Used by |
|---|---|---|
| `api` | `DATABASE_URL` (role `tessera_app`, `sslmode=verify-full`), `VALKEY_URL` (`rediss://:<token>@…`), `SMTP_URL`, `PASSWORD_PEPPER`, `SECRET_BOX_KEYS`, `TURN_SHARED_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `FRANKING_KEYS`, `MODERATION_HPKE_PUBLIC_KEY`, `MODERATION_HPKE_PRIVATE_KEY`, `LINK_PREVIEW_FETCHER_TOKEN`; optional billing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | API, admin API |
| `admin` | `ADMIN_OIDC_CLIENT_ID`, `ADMIN_OIDC_CLIENT_SECRET` | admin API |
| `realtime` | `DATABASE_URL` (role `tessera_realtime`), `VALKEY_URL` | realtime |
| `link-fetcher` | `FETCHER_TOKEN` (= `LINK_PREVIEW_FETCHER_TOKEN`) | link fetcher |
| `migrate` | `DATABASE_URL` (role `tessera_migrator`) | migration Job |
| `coturn` | `TURN_STATIC_AUTH_SECRET` (= `TURN_SHARED_SECRET`) | coturn |
| `livekit` | `LIVEKIT_KEYS` (`<key>: <secret>`), `REDIS_HOST`, `REDIS_PASSWORD` | LiveKit |

Generate keys on a trusted machine: 32 random bytes base64 for peppers and box keys
(`openssl rand -base64 32`), VAPID with `npx web-push generate-vapid-keys`, the moderation HPKE
pair as documented in docs/moderation.md. Formats are validated at boot; a wrong one stops the
pod with a `*.boot_failed` line naming the setting.

## Rotation

Keyrings rotate without downtime: `PASSWORD_PEPPER`, `SECRET_BOX_KEYS` and `FRANKING_KEYS` take
`id:key` lists — add the new key first (`k2:new,k1:old`), deploy, and the old one keeps
verifying/decrypting while new writes use the first. Remove the old key only after the data it
protects has been re-written or expired (franking keys: after the report window, docs/moderation.md).
Single-value secrets (tokens, client secrets, database passwords) rotate by setting both ends:

1. Update the secret in Secrets Manager (for paired secrets, both: e.g. `api.LINK_PREVIEW_FETCHER_TOKEN`
   and `link-fetcher.FETCHER_TOKEN`; `api.TURN_SHARED_SECRET` and `coturn.TURN_STATIC_AUTH_SECRET`).
2. Wait for External Secrets (`refreshInterval` 1 h) or annotate the ExternalSecret to force it.
3. `kubectl -n tessera rollout restart deploy/<name>` for each consumer.

Database passwords: `ALTER ROLE … PASSWORD` as the master user, then the steps above. VAPID keys
cannot be rotated without every browser re-subscribing — rotate only if compromised.

## A secret leaked

Severity 1 if it protects user data (pepper, box keys, moderation private key, database
credentials) — incident-response.md. Rotate at once as above; for the pepper and box keys add a
new key and re-encrypt/re-hash on next use; revoke all sessions if session or database
credentials leaked. Record what the secret allowed and for how long (for the notices).
