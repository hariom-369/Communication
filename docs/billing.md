# Billing and subscriptions

Status: NEEDS-LEGAL-REVIEW (L-11) · Decision: ADR-024

## 1. Design

```
          ┌────────────┐  webhooks   ┌───────────────────┐ events  ┌──────────────┐
Razorpay ─▶│ payments   │────────────▶│ billing (plans,   │────────▶│ entitlements │◀── every module asks
Stripe   ─▶│ adapters   │             │ subscriptions,    │         │ can()/limit()│    "can user X do F?"
          └────────────┘             │ invoices, dunning)│         └──────────────┘
                                      └───────────────────┘
```

- **Messaging, groups, media never import billing.** They call `entitlements.limit(user,
  'upload.max_bytes')` etc. Entitlements are cached (Valkey, 60 s) with DB fallback.
- Card/UPI data never touches our servers (hosted checkout / provider SDK); we store
  provider customer/subscription IDs only → PCI DSS scope SAQ-A.

## 2. Tiers (initial proposal — product to finalise)

| Entitlement | FREE | PREMIUM | CREATOR | BUSINESS |
|---|---|---|---|---|
| Max upload | 200 MiB | 2 GiB | 2 GiB | 2 GiB |
| Linked devices | 8 | 8 | 8 | 8 + team-managed devices |
| Backup media size | 2 GiB | 50 GiB | 50 GiB | 50 GiB |
| Custom themes, app icons | — | ✓ | ✓ | ✓ |
| Premium usernames (short) | — | ✓ | ✓ | ✓ |
| Channel scheduled posts, advanced analytics | basic | basic | ✓ | ✓ |
| Communities: advanced roles, verification gates | basic | ✓ | ✓ | ✓ |
| Business profile, verified badge, team inbox | — | — | — | ✓ |

Security and privacy features (E2EE, passkeys, 2FA, verification, backups with basic
size) are **never paywalled**.

## 3. Subscription state machine

`trialing → active → past_due → (grace 7 days) → canceled | active`; `active → cancel_at_period_end → canceled`.
Entitlements degrade gracefully on downgrade (existing large files remain; new uploads limited).

## 4. Webhooks

Signature verified (provider secret), idempotent on `provider_event_id`, processed via
outbox; out-of-order events resolved by fetching authoritative state from the provider API.

## 5. India-specific considerations (legal/finance review L-11)

RBI e-mandate rules for recurring payments (pre-debit notification, AFA above threshold);
GST invoicing (GSTIN, HSN/SAC codes, place of supply); consumer-protection rules (clear
pricing, easy cancellation, no dark patterns per CCPA 2023 guidelines, refund policy);
app-store billing rules when native apps launch (Google Play / Apple IAP policies).

## 6. Tests

Webhook replay/duplication/out-of-order; forged signature rejected; entitlement change
reflected within 60 s; downgrade behaviour; proration; tax calculation fixtures.
