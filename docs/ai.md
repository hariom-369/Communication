# AI features — privacy architecture

Status: PROPOSED (post-GA features) · Legal: SGI labelling under IT Rules 2026 (L-05)

## 1. Rules

1. E2EE content is **never** automatically sent to any AI system (ours or third-party).
2. AI on private content happens only on explicit, per-invocation user action, with a
   disclosure sheet stating exactly what leaves the device and to whom.
3. Prefer on-device models where feasible (browser: WebGPU/WASM small models).
4. Provider contracts must forbid training on and retention of submitted content
   (zero-data-retention terms); data residency reviewed (L-14).
5. AI-generated content produced *by Tessera features* in public surfaces is labelled
   per the synthetic-content (SGI) rules.

## 2. Feature matrix — what leaves the device

| Feature | Surface | Data sent | Trigger |
|---|---|---|---|
| Translate message | E2EE chat | the single selected message text | user taps "Translate" (on-device model preferred) |
| Summarise unread | E2EE chat | selected messages (user confirms count) | user action; disclosure sheet |
| Writing assistance | composer | the draft text only | user action |
| Smart replies | E2EE chat | **on-device only**; otherwise feature unavailable | — |
| Voice transcription | voice note | audio of that note | on-device preferred; cloud only by explicit action |
| Support bot | help center | user's support question + account metadata they allow | user chat with support |
| Community moderation assistant | large rooms / channels (non-E2EE) | public/server-protected content | community admin enables |
| Spam detection | metadata + public content | behaviour signals, public content | automatic (no E2EE content) |
| Channel analytics insights | channel owner | aggregated channel metrics | owner action |

## 3. Architecture

`services/api` exposes `/ai/*` routes that proxy to a provider via an `AiProvider`
interface; requests carry no user identifiers beyond a per-request pseudonym; logs record
feature, token counts and latency only — never prompts or outputs. Feature flags +
per-user consent records.
