# Runbook — breached-password mirror

Alert: `BreachedPasswordCheckUnavailable` (ticket); log `auth.breach_check_unavailable`.

The API checks every new password against a mirror of the Pwned Passwords range files: it sends
the first 5 hex characters of the password's SHA-1 and compares the suffixes locally
(`services/api/src/modules/auth/breached.ts`). The mirror is an S3 bucket
(`PWNED_PASSWORDS_URL`) read through the VPC endpoint only. If it cannot answer within 2 s the
check **fails open**: the password is judged by the strength estimator alone.

**User impact.** None visible; the risk is that breached passwords are accepted meanwhile.

## Confirm and fix

1. `curl -sS "$PWNED_PASSWORDS_URL/range/21BD1"` from an API pod's network (debug pod in the
   namespace): expect ~800 lines `SUFFIX:COUNT`.
2. 403: the bucket policy lost the VPC-endpoint condition, or the endpoint changed — see
   [s3-misconfiguration.md](s3-misconfiguration.md). 404: objects missing — re-run the refresh.
3. Timeouts: VPC endpoint or DNS; the API's NetworkPolicy allows 443 to the VPC CIDR.

## Monthly refresh

Run the official downloader (`haveibeenpwned-downloader`, SHA-1 mode, one file per prefix) on a
build runner, upload with `aws s3 sync --delete` to the bucket under `range/`, and spot-check
three prefixes. Record the date in the operations log.

## Afterwards

Users who set a password while the check was down are not notified automatically; the next
sign-in does not re-check. If the outage was long, decide (security lead) whether to require a
password change for accounts whose password changed in the window (`auth_credentials.updated_at`).
