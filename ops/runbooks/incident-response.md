# Runbook — incident response

For any event that harms or threatens users' data, accounts or the service: an outage that
breaks an SLO, a suspected compromise, a leaked secret, a personal data breach. Severities
decide who is woken; the **legal clocks start at the moment we notice**, not when we are sure.

## Severities

| Sev | Meaning | Examples | Response |
|---|---|---|---|
| 1 | Users' data or accounts exposed or at risk, or the service down for everyone | key or credential compromise, mass account takeover, data exfiltration, total outage | page on-call + incident lead + security lead now; status page within 30 min |
| 2 | Major feature down or degraded for many; contained security event | messaging delayed, sign-in failing, Valkey lost, a single admin account misused | page on-call; incident lead if not resolved in 30 min |
| 3 | Limited impact, workaround exists | one region of features slow, push delays | ticket, next working hours |

## Roles

- **Incident lead** — owns the incident, decides, keeps the timeline. Not the person fixing.
- **Operations** — the on-call engineer(s) doing the work.
- **Communications** — status page and user notices; with Legal for regulators.
- **Security lead** — any suspected compromise; decides on forensics and evidence preservation.
- **Legal / DPO** — regulator and user notifications (compliance.md §2.2–2.3).

## First 30 minutes

1. Open an incident channel and a timeline document; note the time of detection (UTC and IST).
2. Assign the roles above. Freeze deploys (`production` environment: no approvals).
3. Stabilise: the per-alert runbooks (README.md). Prefer reversible actions: kill switches,
   rollback, scaling, revoking sessions.
4. Preserve evidence before changing compromised systems: snapshot volumes and the database,
   export relevant logs (CloudTrail, VPC flow logs, application logs), record hashes.
5. Decide whether this may be a **cyber security incident** (CERT-In list) or a **personal data
   breach** (DPDP). If unsure, treat it as one — the clocks below run.

## Legal clocks (compliance.md; wording and templates pending legal review, L-items)

| Clock | Duty | Owner |
|---|---|---|
| **6 hours** from noticing | Report a reportable cyber security incident to CERT-In (incident@cert-in.org.in, the prescribed form) | Security lead with Legal |
| **Without delay** | Inform affected Data Principals of a personal data breach (what happened, likely consequences, what we do, what they can do, contact) | DPO |
| **72 hours** | Detailed report of a personal data breach to the Data Protection Board | DPO with Legal |
| Ongoing | Answer CERT-In information requests; keep ICT logs for 180 days (in India) | Security lead |

E2EE limits what a server compromise exposes (message and media content are ciphertext; see
docs/threat-model.md), but metadata, account data and keys held by the server (pepper, secret
box keys, franking and moderation keys, VAPID) can be — say exactly which in notices.

## Containment toolbox

- Sign everyone out: revoke all sessions (`UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL` as the
  migrator role; clients reconnect and must sign in — realtime sockets close within the
  session-recheck interval).
- Rotate secrets ([secrets.md](secrets.md)); a leaked admin credential: disable the admin in the
  console or with the operator command, revoke their sessions.
- Block abusive traffic at the edge ([ddos.md](ddos.md)).
- Kill switches (admin console, four eyes): `link_previews`, `group_calls`, `billing`.

## Afterwards

Within 5 working days: blameless review — timeline, impact (users, data), root cause, what
detection missed, actions with owners and dates. File regulator follow-ups. Update the runbook
that was missing or wrong.

## Testing this runbook

A tabletop exercise per quarter (scenario, the clocks, who writes which notice), recorded in the
operations log; the public beta gate (docs/launch-readiness.md) needs one completed with the
people who hold these roles.
