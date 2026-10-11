# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately using GitHub's **"Report a vulnerability"** button on the
repository's **Security** tab (private vulnerability reporting). Do not open public issues for
security problems.

Include: affected component, reproduction steps or proof of concept, impact, and any suggested fix.
We acknowledge reports within 3 business days, triage within 10, and keep you informed at least
every 14 days until resolution. Timelines, safe harbour, scope and coordinated disclosure:
[docs/security/bug-bounty.md](docs/security/bug-bounty.md). A paid bounty opens after general
availability; until then reports are handled the same way without monetary rewards.

## Supported versions

The web app is a single continuously deployed release; only the current release is supported.
The service worker refuses to roll back to an older release (docs/e2ee.md §7), so fixes reach
every browser that opens the app.

## Scope and design documents

The security architecture, threat model and cryptographic design are documented in
[`docs/security.md`](docs/security.md), [`docs/threat-model.md`](docs/threat-model.md) and
[`docs/crypto-design.md`](docs/crypto-design.md); every route's authentication, authorization,
rate limit and audit is listed in [`docs/security/route-matrix.md`](docs/security/route-matrix.md)
(generated from the code), and our own findings are in
[`docs/security/review.md`](docs/security/review.md). Reports that show a gap between those
documents and the implementation are especially valuable.

## Handling rules for contributors

- Never commit secrets; `.env` files are git-ignored and CI runs a secret scan.
- Never log message content, credentials, tokens or keys; the logger drops non-allow-listed fields.
- Changes to cryptographic code or documents require review by the designated cryptography reviewer.
- New routes need an explicit authorization policy, rate limit and audit decision (enforced by the
  route types and `security-matrix.test.ts`); unparameterised SQL, `eval`, HTML injection and
  `Math.random` are lint errors.
