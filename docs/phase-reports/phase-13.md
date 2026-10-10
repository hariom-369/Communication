# Phase 13 report — Billing

**Status: GREEN locally; pending legal and tax review (L-11).** Verified 2026-10-10. CI has not
run, because the branch still cannot be pushed (GitHub returns 403 for the Claude app).

People can buy a plan from Settings → Plan. In India they pay in rupees on Razorpay's page (UPI,
cards, e-mandates); elsewhere in dollars on Stripe's. Tessera never sees card or UPI details.
A payment raises the account's limits on its next request and produces a GST tax invoice;
cancelling takes one step and the plan runs to the end of the paid period. The free plan is
exactly what everyone had before, and security and privacy features are free on every plan.
Design and trade-offs: **ADR-051** (building on ADR-024) and [billing.md](../billing.md) §0.

## Results

| Gate | Result |
|---|---|
| Format, lint, typecheck, build | pass |
| Unit tests | **627 TypeScript** (api 398, web 139, ui 59, platform 15, shared 7, realtime 3, validation 3, admin 3) + **75 Rust** (crypto core unchanged) |
| Integration (real PostgreSQL + Valkey + S3-compatible store + coturn) | **239 passed** (api 222, of which **20 billing**; realtime 17); 2 skipped (IPv6 TURN test without IPv6 here; opt-in channel scale test) |
| End-to-end, user app (Chromium, production build, strict CSP + Trusted Types, real services, payment stand-in) | **47 passed in each of 3 consecutive full runs** (3 new billing tests) and in a fourth run; the billing spec 3 more times after a last change; 1 skipped (opt-in call load test) |
| End-to-end, admin console | First batch of three: run 1 produced no result before its 10-minute timeout and left its processes behind, so runs 2 and 3 failed (the identity provider's port was taken by the leftover one). After cleaning up: **6 passed in 5 consecutive runs**, one of them directly after a full user-app run (the original sequence). The hang did not reproduce and its output was not captured; the setup now refuses to start when its identity provider cannot bind the port, so a leftover can no longer cause misleading failures (open item below) |
| Mutation checks | **17 of 17** seeded faults caught (below) |
| Accessibility (axe) | no violations on the plan page (free and paid) and an invoice |
| OpenAPI (user API) | 182 paths, 214 operations (11 new paths, 12 new operations: billing, entitlements, two webhooks) |
| `pnpm audit --prod` / gitleaks | no known vulnerabilities / no leaks (history and every file to be committed; the stand-in's credentials are generated per run, no key-shaped literals) |

### Exit criteria

| Criterion | Evidence |
|---|---|
| **Webhook idempotency** | `billing.integration.test.ts`: every delivery of a payment sent twice answers `duplicate: true` with one invoice; six concurrent copies of one payment event apply once and use exactly one invoice number; deliveries in reverse order and a stale "activated" retry after the subscription ended leave the provider's current state; forged (Stripe and Razorpay), tampered, stale-timestamp, unsigned, missing-event-id and wrong-endpoint deliveries are refused and record nothing; refund totals never decrease |
| **Entitlement propagation** | the account's limits are read (and cached as free) before paying; after the payment webhooks the very next request sees the paid tier (media accepts a 300 MB file, channels schedule 200 days ahead, 100 channels); a second API process sees the same tier through the shared cache; a cached paid tier ends exactly at `valid_until`; cancellation keeps the tier to the period end and the provider's end event removes it; a failed renewal keeps it 7 days from the first failure; the E2E test shows the plan page change after paying on the provider's page |

## Delivered

- **Billing module** (`modules/billing`, migration `0014_billing.sql`, 11 routes): plans with INR
  (GST-inclusive) and USD prices; billing details (name, country, Indian state, optional GSTIN
  checked against the state); hosted checkout; subscription view; cancellation (one step, at
  period end) and resumption where the provider allows it; invoices; two webhook endpoints.
- **Provider adapters** (`providers.ts`): Stripe Checkout sessions and subscriptions (API version
  pinned), Razorpay subscriptions; signature verification per provider; status mapping; Zod
  validation of every provider response.
- **Webhook pipeline**: a `webhook` auth kind (no session, no browser CSRF check, raw body) in
  the route framework; JSON parsing unchanged for every other route.
- **Entitlements module** (`modules/entitlements`): tier table written by billing in its
  transaction, Valkey cache (60 s) dropped after commit, `GET /api/v1/entitlements`; media
  (file size, daily volume and count) and channels (channels owned, scheduling window) read their
  limits through it. The database cap on attachment size was raised to the largest plan's.
- **GST invoices** (`tax.ts`): per payment, consecutive numbers per financial year (IST),
  CGST+SGST or IGST, exports zero-rated, seller and buyer snapshots, refunds recorded.
- **Web app**: Settings → Plan (current tier and what it allows, plans in the person's currency,
  billing details, checkout redirect and return, cancellation dialog stating when the plan ends,
  invoices) and a printable invoice page; attachments check the plan's limit before encrypting.
- **Admin console**: the account view shows the plan (tier, status, period end, provider).
- **Kill switch**: feature flag `billing` pauses new checkouts (existing plans unaffected).
- **Test tools**: a payment stand-in (`src/test/fake-payments.ts`) implementing the endpoints the
  adapters call, both providers' webhook signing, and a hosted payment page; run as a process for
  E2E (`scripts/fake-payments.mjs`).

## Tests added

- `billing.integration.test.ts` (20) — exit criteria above, plus: prices by country, no plan
  without billing details, one plan at a time, country locked while a plan runs, kill switch;
  Razorpay and Stripe end to end with invoices (intra-state CGST/SGST, inter-state IGST, export);
  invoices owner-only; renewal adds an invoice; Razorpay cancellations cannot be undone; two paid
  checkouts → one plan, the other ended and flagged; audit entries without payment details.
- `tax.test.ts` (5): splits for every amount, IGST, exports, financial-year boundary in IST,
  16-character invoice numbers.
- `config.test.ts` (+2): providers all-or-nothing, seller details, seller GSTIN state, no stand-in
  URLs or test keys in production. `media.integration.test.ts`: the free plan's 200 MB limit
  answers 413 with the reason; sizes beyond any plan fail validation.
- `apps/web/e2e/billing.spec.ts` (3): India/Razorpay (details → plan → provider page → paid →
  invoice with CGST/SGST → cancel); abroad/Stripe (Creator → country locked → cancel → keep plan →
  export invoice); axe on the plan and invoice pages. `billing/format.test.ts` (3).

### Mutation checks (17/17 caught)

Duplicate event not detected inside the transaction · Stripe timestamp tolerance removed · Stripe
signature not checked · Razorpay signature not checked · Razorpay event id not required · state
taken from the event instead of the provider · entitlement cache not invalidated · grace restarted
on every retry · refund total allowed to decrease · any subscription can remove a tier · a cached
tier outlives its end · media ignores the plan's file limit · channels ignore the plan's
scheduling window · CGST/SGST for inter-state buyers · invoices readable by anyone · a second plan
allowed · past-due grace without an end.

The first run left one uncaught (no test forged a *Razorpay* signature with a valid event id); a
test was added.

## Problems found and fixed during the phase

- **The upload part limit capped files at 512 MB** and the database capped them at 256 MB; both
  were raised to the largest plan's limit (1 GB) — the per-account limit is the API's.
- The past-due grace period was first computed from the period end — for Stripe that is the
  *next* period's end after a failed renewal, which would have given a month of grace; it now runs
  from the first failure.
- A second paid checkout's state could flip back from "duplicate" when its own next event
  arrived; that is correct (the provider's state wins), and the test now checks the outcome
  (ended at the provider) rather than the intermediate label.
- The proposed 2 GB paid attachment limit is not safe yet (the browser holds the encrypted file in
  memory); 1 GB until streamed uploads (Phase 14).

## Security implications (threat-model delta)

Recorded in [threat-model.md](../threat-model.md) (Phase 13 delta), [security.md](../security.md)
(billing) and [privacy.md](../privacy.md) (plans, billing details, invoices, webhook events). In
short: payment providers are a new trust boundary; a webhook is honoured only with the provider's
signature, once per event, and only for the state the provider reports now; no card or UPI data
is ever held; the webhook endpoints are the only routes without a browser CSRF check, and they
read no session. Residual: the provider (or someone with its API key or dashboard) is trusted for
payment state; invoices hold names, states and GSTINs for the statutory period.

## Open items

- **Admin E2E hang, once** (see Results): not reproduced in 5 later runs, including the same
  sequence; its output was not captured. Next occurrence: keep the output (the runs now save the
  full report) and fix the cause.

## Moved / not done

- Streamed uploads (files above 1 GB) → Phase 14.
- Credit notes, proration and switching plans without cancelling → after L-11.
- Themes, premium usernames, team inboxes, business badges — not built, so not sold.
- Billing role in the admin console beyond the read-only plan view (refunds and disputes are done
  in the providers' dashboards).
- Real provider sandboxes are not exercised (no credentials here); the adapters follow the
  documented APIs and are tested against the stand-in. The first staging deployment must run a
  sandbox payment per provider (Phase 17 checklist).

## Commit

Branch `claude/trusting-goodall-55613i`. Push still blocked (403) — the user needs to reconnect
GitHub with the Claude app installed (https://claude.ai/connect-github).
