# Vulnerability disclosure and bug bounty

Status: **policy ready; the paid bounty opens after GA** (security.md §13). Until then this
document is the vulnerability disclosure policy: reports are welcome and handled the same way,
without monetary rewards. Reward amounts are a business decision and are published here when the
programme opens — none are promised before that.

## 1. How to report

Use GitHub's private vulnerability reporting (the **Security** tab → "Report a vulnerability"),
as described in [SECURITY.md](../../SECURITY.md). Include the affected component, steps to
reproduce or a proof of concept, the impact you expect, and any suggested fix. Please do not
include other people's data in a report.

## 2. What we commit to

| Step | Target |
|---|---|
| Acknowledge the report | 3 business days |
| Triage with a severity (CVSS 4.0) and a first assessment | 10 business days |
| Fix critical / high findings | as fast as possible; critical within 7 days, high within 30 days |
| Keep you informed | at least every 14 days until resolved |
| Coordinated disclosure | we agree a date with you; by default 90 days after the report, earlier once fixed, later only by agreement |
| Credit | in the release notes and security advisory, if you want it |

## 3. Safe harbour

We will not pursue legal action against, or ask a provider to act against, anyone who in good
faith: tests only accounts they own or have permission to use; stops and reports as soon as they
reach other people's data; does not degrade the service for others; does not keep, share or use
data beyond what the report needs; and gives us reasonable time to fix before disclosure. If
legal action is started by a third party against you for such research, we will make it known
that your activity was authorised under this policy. (Legal text to be confirmed by counsel —
review register L-15.)

## 4. In scope

- The web app, API, realtime gateway and admin console at the production and staging origins
  listed in SECURITY.md once they exist.
- The code in this repository, in particular the cryptographic core (`packages/crypto-core`) and
  its use in the web app.
- Especially valuable: anything that lets the server or a network attacker read message
  content, add a device or member unnoticed, impersonate a user, bypass authorization on another
  user's objects, escalate inside the admin plane, or bypass the signed-release pinning of the web
  app; and any gap between our security documents and what the code does.

## 5. Out of scope

- Denial of service by volume, spam, and social engineering of staff or users.
- Findings that need a compromised device, browser or operating system, or physical access.
- Self-XSS, clickjacking on pages without sensitive actions, missing headers without a
  demonstrated impact, version disclosure, rate limits that are merely generous.
- Vulnerabilities in third-party services (payment, push, identity providers) — please report
  them to the vendor; tell us if our integration makes them exploitable.
- Known limitations we state ourselves: e2ee.md §3 (non-goals and residual risks), e2ee.md §7
  (web code delivery), privacy.md (server-visible metadata), capacity.md §4.

## 6. Handling inside the team

Reports go to the security on-call rotation (Phase 17 runbooks). Each report gets a tracking
issue in a private security advisory, a severity, an owner and a fix deadline per §2; critical
findings page the on-call engineer. Fixes include a regression test. After the fix ships, the
advisory is published with credit, and the threat model and review register are updated if the
finding changes them.
