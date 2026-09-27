# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately using GitHub's **"Report a vulnerability"** button on the
repository's **Security** tab (private vulnerability reporting). Do not open public issues for
security problems.

Include: affected component, reproduction steps or proof of concept, impact, and any suggested fix.
We acknowledge reports within 3 business days and keep you informed until resolution.

## Scope and design documents

The security architecture, threat model and cryptographic design are documented in
[`docs/security.md`](docs/security.md), [`docs/threat-model.md`](docs/threat-model.md) and
[`docs/crypto-design.md`](docs/crypto-design.md). Reports that show a gap between those documents and
the implementation are especially valuable.

## Handling rules for contributors

- Never commit secrets; `.env` files are git-ignored and CI runs a secret scan.
- Never log message content, credentials, tokens or keys; the logger drops non-allow-listed fields.
- Changes to cryptographic code or documents require review by the designated cryptography reviewer.
