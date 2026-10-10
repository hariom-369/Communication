# Billing and subscriptions

Status: IMPLEMENTED (Phase 13, ADR-024, ADR-051) · NEEDS-LEGAL-REVIEW (L-11: prices, GST
treatment, SAC code, refund policy, RBI e-mandate obligations)

## 0. As built (Phase 13)

| Part | Where |
|---|---|
| Plans, billing details, checkout, cancellation, webhooks, GST invoices | `services/api/src/modules/billing/` |
| Provider adapters (Stripe, Razorpay) | `services/api/src/modules/billing/providers.ts` |
| Tax computation and invoice numbering | `services/api/src/modules/billing/tax.ts` |
| Entitlements (tier → limits, cached, propagated) | `services/api/src/modules/entitlements/` |
| Limits enforced | `modules/media` (file size, daily volume and count), `modules/channels` (channels owned, scheduling window) |
| Plan page, invoices | `apps/web/src/pages/settings/PlanPage.tsx`, `InvoicePage.tsx` |
| Admin view (plan only) | admin console account view (`billing` in the user detail) |
| Schemas | `packages/validation/src/billing.ts` · migration `0014_billing.sql` |

Tests: `billing.integration.test.ts` (20: **webhook idempotency** — duplicates, six concurrent
deliveries of one event, out-of-order and stale retries, forged/tampered/stale/unidentified
deliveries; **entitlement propagation** — limits change on the next request after payment, end
on time, are shared across API processes; GST invoices; cancellation, resumption, renewal,
grace, refunds, duplicate checkouts; audit), `tax.test.ts`, config tests, 17 mutation checks,
and `apps/web/e2e/billing.spec.ts` (Razorpay and Stripe end to end through the stand-in
provider's payment page, invoice, cancellation, axe).

## 1. Design

```
          ┌────────────┐  webhooks   ┌───────────────────┐  setTier  ┌──────────────┐
Razorpay ─▶│ provider   │────────────▶│ billing (plans,   │──────────▶│ entitlements │◀── media, channels
Stripe   ─▶│ adapters   │             │ subscriptions,    │ (same     │ forUser()    │    ask "what may
          └────────────┘             │ invoices)         │  trans-   └──────────────┘    this account do?"
                                      └───────────────────┘  action)
```

- **Messaging, media, channels never import billing.** They ask the entitlements module, which
  reads the account's tier (`account_tiers`), cached in Valkey for 60 s. Billing changes the tier
  in the same transaction as the subscription and drops the cache entry after the commit, so new
  limits apply on the next request; a cached paid tier still ends exactly at `valid_until`.
- **Card and UPI details never touch our servers.** People pay on the provider's hosted page
  (Stripe Checkout; Razorpay subscription link). Tessera stores provider references only
  (PCI DSS scope SAQ-A).
- **Provider by place:** a billing country of India → rupees through Razorpay (UPI Autopay,
  cards, e-mandates); anywhere else → dollars through Stripe. The country cannot change while a
  plan runs.
- No SDKs: both adapters call the documented REST APIs (`fetch`, 10 s timeout, Stripe API
  version pinned) and verify webhooks with HMAC-SHA256 from `node:crypto`, compared in constant
  time. Provider error bodies are never passed to clients.

## 2. Tiers

Only limits the server enforces are listed. The **free tier is exactly what every account had
before billing** — nothing was taken away to sell it back.

| Entitlement | FREE | PREMIUM | CREATOR | BUSINESS |
|---|---|---|---|---|
| Largest attachment (`media.max_file_bytes`) | 200 MB | 1 GB | 1 GB | 1 GB |
| Upload volume per day (`media.daily_bytes`) | 2 GB | 20 GB | 20 GB | 50 GB |
| Files per day (`media.daily_uploads`) | 300 | 1,000 | 1,000 | 3,000 |
| Channels owned (`channels.max_owned`) | 20 | 20 | 100 | 100 |
| Schedule channel posts ahead (`channels.schedule_days`) | 90 days | 90 days | 365 days | 365 days |

Security and privacy features (end-to-end encryption, passkeys, two-step verification, safety
numbers, device management, backups) are **never paid features**.

Initial prices (product to confirm; INR includes 18% GST): Premium ₹99 / $2.99 a month or ₹999 /
$29.99 a year; Creator ₹299 / $6.99 a month; Business ₹499 / $11.99 a month. A plan is buyable
only where the operator configured the provider's price for it (`STRIPE_PRICES`,
`RAZORPAY_PLANS`); Business is listed but not configured in the test setups.

*Deviation from the earlier proposal:* the 2 GB attachment limit became 1 GB (the browser
assembles the encrypted file in memory; larger files wait for streamed uploads, Phase 14).
Themes, premium usernames, team inboxes and business badges are not built, so they are not sold.
Backup media sizes are not tiered: encrypted backups do not include media yet.

## 3. Subscription states

| Ours | Stripe | Razorpay | Entitles to the tier |
|---|---|---|---|
| `incomplete` | `incomplete` | `created`, `authenticated` | no |
| `active` | `active`, `trialing` | `active` | until the period ends, plus one day for a late renewal webhook |
| `past_due` | `past_due`, `unpaid`, `paused` | `pending`, `halted` | for **7 days from the first failed renewal** (not from each retry) |
| `canceled` | `canceled`, `incomplete_expired` | `cancelled`, `completed`, `expired` | no |

- **Cancellation is one step** and takes effect at the end of the paid period ("You will not be
  charged again"). Stripe cancellations can be undone before the end; Razorpay's cannot, and the
  page says so.
- At most one plan in force per account (database-enforced). If two checkouts are paid (two
  tabs), the second is ended at the provider at once and an alert asks support to refund it.
- Downgrades are graceful: files already sent stay; only new uploads are limited.

## 4. Webhooks

`POST /api/v1/billing/webhooks/stripe` and `/razorpay`: no session, no browser CSRF check (the
pipeline's `webhook` auth kind), the raw body for the signature, 512 KiB limit.

- **Genuine:** Stripe `Stripe-Signature` (`t=…,v1=…` over `"<t>.<body>"`, 5-minute tolerance);
  Razorpay `X-Razorpay-Signature` (HMAC of the body) plus `X-Razorpay-Event-Id`. Anything else:
  400, nothing recorded.
- **Idempotent:** each `(provider, event id)` is inserted into `billing_events` in the same
  transaction as its effect; a duplicate (or a concurrent copy) answers `duplicate: true` and
  changes nothing. No payload is stored.
- **Order-independent:** the state applied is always the provider's *current* state, fetched from
  its API inside a per-subscription advisory lock; a late or replayed event cannot roll a
  subscription back. Refund totals only grow.
- Events for subscriptions that are not Tessera's are acknowledged and ignored; when the provider
  cannot be reached the answer is 503 and the provider retries.

## 5. Invoices and India-specific rules (L-11)

- A **tax invoice per payment**, numbered consecutively per Indian financial year
  (`T/2026-27/000001`, ≤ 16 characters; the counter is part of the payment's transaction, so no
  number is skipped or reused), with the seller's and buyer's names, states and GSTINs, SAC code
  (`BILLING_SAC_CODE`, default 998439 — to confirm), and the GST split: within the seller's state
  CGST 9% + SGST 9%, otherwise IGST 18% (prices include GST); buyers outside India: export of
  services, zero-rated under LUT. Printable / save-as-PDF page in the app. Refunds are recorded on
  the invoice (credit notes: L-11).
- **RBI e-mandates:** pre-debit notifications and additional factor authentication above the
  threshold are performed by Razorpay for UPI Autopay and card mandates; Tessera does not store
  mandate details.
- **Consumer protection / dark patterns (CCPA 2023):** prices shown with tax, the provider named,
  cancellation in one step with a plain statement of when the plan ends, no pre-ticked boxes, no
  confirm-shaming.
- **App stores:** native apps (later) must use the stores' billing rules; not applicable to the web.

## 6. Tests (as built)

See §0. Webhook replay, duplication (including concurrent), out-of-order delivery, forged and
stale signatures; entitlement change reflected on the next request and never beyond `valid_until`;
cancellation, resumption, renewal, 7-day grace from the first failure, refunds, duplicate
checkouts; tax fixtures (intra-/inter-state, export, rounding for every amount, financial-year
boundary in IST); configuration rules (all-or-nothing providers, seller details, no stand-in URLs
or test keys in production). Proration is not offered (plan changes are cancel-then-subscribe).
