# Tessera — secure communication platform

> **Tessera** is a working codename. Trademark and domain clearance is required before
> any public use of the name (see `docs/review-register.md`, item L-01).

Tessera is a production-grade, public, commercial communication platform: private and group
messaging with end-to-end encryption (E2EE), communities, broadcast channels, voice/video
calls, media, multi-device, encrypted backups, moderation, administration and billing.

## Current status: Phase 6 complete (pending cryptography review)

- **Phase 0** — architecture, threat model and research package: [`docs/`](docs/README.md).
- **Phase 1** — repository, tooling, CI/CD and platform foundations:
  [`docs/phase-reports/phase-1.md`](docs/phase-reports/phase-1.md).
- **Phase 2** — accounts, passkeys/passwords/2FA, sessions, audit log, web app:
  [`docs/phase-reports/phase-2.md`](docs/phase-reports/phase-2.md).
- **Phase 3** — messaging transport (conversations, ordered mailbox, delivery states, sync),
  realtime WebSocket service, chat UI:
  [`docs/phase-reports/phase-3.md`](docs/phase-reports/phase-3.md). Chat is available only in
  development builds only at that stage (ADR-038, now superseded).
- **Phase 4** — end-to-end encryption with MLS (RFC 9420, OpenMLS) in a WebAssembly crypto
  worker: identity keys and device certificates, KeyPackages, 1:1 groups, safety numbers,
  key-change warnings, encrypted on-device history:
  [`docs/phase-reports/phase-4.md`](docs/phase-reports/phase-4.md). **Not for real users until
  the external cryptography review (S-01..S-04) signs off.**
- **Phase 5** — multi-device: link devices with a code (full access or messages only), history
  transfer, device removal, encrypted backups unlocked by a recovery key or a passkey, restore,
  on-device search: [`docs/phase-reports/phase-5.md`](docs/phase-reports/phase-5.md). Also pending
  review (S-04, S-06).
- **Phase 6** — end-to-end encrypted attachments: photos (location metadata removed), videos,
  voice messages and files, uploaded straight to object storage as ciphertext:
  [`docs/phase-reports/phase-6.md`](docs/phase-reports/phase-6.md). Pending review (S-05).
- **Next: Phase 7** — groups and communities.

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
