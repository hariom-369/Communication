# Tessera — secure communication platform

> **Tessera** is a working codename. Trademark and domain clearance is required before
> any public use of the name (see `docs/review-register.md`, item L-01).

Tessera is a production-grade, public, commercial communication platform: private and group
messaging with end-to-end encryption (E2EE), communities, broadcast channels, voice/video
calls, media, multi-device, encrypted backups, moderation, administration and billing.

## Current status: Phase 0 — architecture for review

**No application code has been written yet.** This is deliberate: the project methodology
(see `docs/implementation-plan.md`) requires the architecture to be reviewed and
internally consistent before implementation starts.

Phase 0 deliverables live in [`docs/`](docs/README.md). Start with:

1. [`docs/README.md`](docs/README.md) — index and reading order
2. [`docs/decisions.md`](docs/decisions.md) — every architectural decision, with alternatives and trade-offs
3. [`docs/review-register.md`](docs/review-register.md) — items that are **blocked on specialist security review or legal review**
4. [`docs/implementation-plan.md`](docs/implementation-plan.md) — phase-by-phase plan and exit criteria

## Non-negotiables (summary)

- No custom cryptography. Established protocols (MLS, RFC 9420) via an audited
  implementation (OpenMLS); established primitives only.
- The backend never receives private-message plaintext, private keys, or plaintext backups.
- Authentication tokens never live in `localStorage`; sessions use `__Host-` HttpOnly cookies.
- No feature is "done" without UI + API + DB + authz + validation + errors + security +
  tests + observability + docs (`docs/implementation-plan.md` §Definition of Done).
- No secrets in the repository. `.env.example` only.
