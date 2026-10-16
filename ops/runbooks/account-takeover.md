# Runbook — credential stuffing and account takeover

Signals: `tessera_http_requests_total{route="auth.login_password",status_class="4xx"}` rising,
the admin console's failed-sign-in hotspots, users reporting security alerts they did not
cause (password changes and resets, factor changes and new encryption devices raise one by
e-mail and on every device; a plain sign-in does not — it shows in the user's session list).

What protects users already: Argon2id with a pepper, the breached-password check, per-identifier
and per-address limits, uniform timing for unknown accounts, two-step verification and passkeys,
re-authentication for every credential and factor change (F-11), and E2EE — a taken-over account
does not get message history (new devices start empty unless the user restores an encrypted backup
with their own key), and contacts see the new device (key-change warnings).

1. **Stuffing in progress:** tighten the WAF rate rule and add a rule for the attack's
   fingerprint (user agent, paths, ASN). Risk-based challenges are not built yet (security review
   F-09) — this runbook is the stopgap.
2. **Accounts known taken over:** for each, revoke all sessions (admin console, purpose-bound
   account view → sign out everywhere), require a password reset, and notify the user.
3. **Mass takeover** is a severity 1 incident and possibly a personal data breach
   (incident-response.md): metadata and account data of the accounts were exposed.
