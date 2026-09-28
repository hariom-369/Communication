# Tessera — secure communication platform

> **Tessera** is a working codename. Trademark and domain clearance is required before
> any public use of the name (see `docs/review-register.md`, item L-01).

Tessera is a production-grade, public, commercial communication platform: private and group
messaging with end-to-end encryption (E2EE), communities, broadcast channels, voice/video
calls, media, multi-device, encrypted backups, moderation, administration and billing.

## Current status: Phase 3 complete

- **Phase 0** — architecture, threat model and research package: [`docs/`](docs/README.md).
- **Phase 1** — repository, tooling, CI/CD and platform foundations:
  [`docs/phase-reports/phase-1.md`](docs/phase-reports/phase-1.md).
- **Phase 2** — accounts, passkeys/passwords/2FA, sessions, audit log, web app:
  [`docs/phase-reports/phase-2.md`](docs/phase-reports/phase-2.md).
- **Phase 3** — messaging transport (conversations, ordered mailbox, delivery states, sync),
  realtime WebSocket service, chat UI:
  [`docs/phase-reports/phase-3.md`](docs/phase-reports/phase-3.md). Chat is available only in
  development builds and is **not yet end-to-end encrypted** (ADR-038); production builds do not
  contain it.
- **Next: Phase 4** — E2EE foundation (MLS via OpenMLS). It needs the external cryptographic
  review (S-01..S-04) before anything ships to users.

Start with:

1. [`docs/README.md`](docs/README.md) — index and reading order
2. [`docs/decisions.md`](docs/decisions.md) — every architectural decision, with alternatives and trade-offs
3. [`docs/review-register.md`](docs/review-register.md) — items **blocked on specialist security or legal review**
4. [`docs/implementation-plan.md`](docs/implementation-plan.md) — phase-by-phase plan and exit criteria
5. [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup and everyday commands

## Non-negotiables (summary)

- No custom cryptography. Established protocols (MLS, RFC 9420) via an audited
  implementation (OpenMLS); established primitives only.
- The backend never receives private-message plaintext, private keys, or plaintext backups.
- Authentication tokens never live in `localStorage`; sessions use `__Host-` HttpOnly cookies.
- No feature is "done" without UI + API + DB + authz + validation + errors + security +
  tests + observability + docs (`docs/implementation-plan.md` §Definition of Done).
- No secrets in the repository. `.env.example` only.
