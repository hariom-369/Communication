# Launch readiness

Status on 2026-10-16, end of Phase 17. **Public beta cannot open yet.** The software side of the
launch gates is done and tested; what remains needs people outside this repository — independent
assessors, lawyers, appointed officers — and a real staging environment. This page is the list,
kept current by whoever owns the launch.

## 1. The gates of prd.md §9

| Gate | Status | Evidence / what is missing |
|---|---|---|
| Phases 0–7 and 10–12 exit criteria met | **Met** | phase reports 0–12 (docs/phase-reports/); Phase 12 "pending review" refers to S-14 below |
| External cryptographic review of Phases 4–5 complete (S-01..S-05) | **Not met — external** | code and documents ready for review since Phases 4–6 (review-register.md); scoping brief security/audit-brief.md; needs an independent cryptographer engaged and the findings resolved |
| Legal sign-off on L-01..L-09 | **Not met — legal** | questions and the engineering side of each are in review-register.md and compliance.md; L-02 (SIM binding) and L-04 (traceability) can change the product; L-09's process is written (ops/runbooks/incident-response.md) and needs counsel's review of the clocks and templates |
| Grievance officer and contact published | **Not met — appointment** | the grievance form and flow are built (Phase 11: `moderation.grievance`, 7-day tracking); a named officer and contact (L-15) must be appointed and published |
| Incident response runbook tested | **Not met — exercise** | runbook written (ops/runbooks/incident-response.md) with roles, severities, CERT-In 6 h and DPDP clocks; a tabletop exercise with the people holding the roles is still to be held and recorded |

## 2. What staging must show before beta

Staging does not exist yet. Bringing it up is itself the first test of Phase 17's work:

1. `terraform plan` and `apply` in the staging account (infra/terraform has only been checked
   statically); cluster bootstrap (infra/terraform README).
2. The first release tag through `release.yml` (SBOMs, scan, signatures — never run yet) and a
   deploy through `deploy.yml`.
3. The end-to-end suite against staging's real edge (CloudFront, WAF, ALB, TLS), and a TLS/header
   scan of the public endpoints (ASVS V12, still "Partial").
4. DR in staging: RDS point-in-time restore with the checks of ops/runbooks/dr-restore.md and the
   measured restore time; a Valkey failover; one regional bring-up in ap-south-2 (RTO target
   < 4 h).
5. Load in staging: Stage 2 with headroom (docs/capacity.md), the realtime pod crash with the
   production pod size (F-14), a 24-hour soak, 32-participant calls through the SFU and TURN.
6. External penetration test and implementation audit (S-13) against staging.

## 3. Open findings and decisions

| Item | Owner | Note |
|---|---|---|
| F-09 risk-based challenges, credential-stuffing detection | engineering + privacy | before beta; needs a provider and a privacy decision (ops/runbooks/account-takeover.md is the stopgap) |
| F-14 realtime crash headroom | engineering | sized (N+1, 10–12k sockets per pod); measure in staging |
| Image-signature admission policy | engineering | bootstrap step, not yet written as manifests |
| SLSA Build L3, reproducible builds, release transparency log | engineering | after GA unless an assessor asks earlier |
| Service mesh (in-cluster mTLS) | engineering | plain HTTP inside the VPC today (ASVS V12) |
| Automated canary analysis | engineering | manual watch for 30 minutes after production rollouts |
| Shield Advanced | business | cost decision (ops/runbooks/ddos.md) |
| Secrets replication to the DR region, automated rotation | engineering | manual today (ops/runbooks/secrets.md, dr-region.md) |
| L-10..L-15 | legal | L-11 billing and L-12 CSAM reporting before their features open to users; L-15 terms, policy and the grievance officer before beta |

## 4. Staged rollout once the gates are met

Invite-only beta in India first (the sign-up limits and moderation staffing are sized for it),
then open sign-up, then GA after the S-13 findings are closed. Kill switches for link previews,
group calls and billing exist (admin console, four eyes). An invite-code gate for sign-up is
**not built**; until it is, a closed beta means not publishing the URL and watching sign-ups —
decide whether that is enough or build the gate first.
