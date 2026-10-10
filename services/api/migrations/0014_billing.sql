-- Phase 13: billing and entitlements (docs/billing.md, ADR-024, ADR-051). Card and UPI details
-- never reach Tessera: people pay on the provider's hosted page; we keep provider references.

-- Plans and their prices. Which provider sells each plan is configuration (provider price ids).
CREATE TABLE billing_plans (
  code              text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$'),
  tier              text NOT NULL CHECK (tier IN ('premium', 'creator', 'business')),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  interval          text NOT NULL CHECK (interval IN ('month', 'year')),
  -- In paise; includes GST.
  price_inr_minor   integer NOT NULL CHECK (price_inr_minor > 0),
  -- In cents.
  price_usd_minor   integer NOT NULL CHECK (price_usd_minor > 0),
  active            boolean NOT NULL DEFAULT true,
  sort_order        smallint NOT NULL DEFAULT 0
);
-- Initial prices (product to confirm; L-11). INR prices include 18% GST.
INSERT INTO billing_plans (code, tier, name, interval, price_inr_minor, price_usd_minor, sort_order) VALUES
  ('premium_monthly', 'premium', 'Premium (monthly)', 'month', 9900, 299, 1),
  ('premium_yearly', 'premium', 'Premium (yearly)', 'year', 99900, 2999, 2),
  ('creator_monthly', 'creator', 'Creator (monthly)', 'month', 29900, 699, 3),
  ('business_monthly', 'business', 'Business (monthly)', 'month', 49900, 1199, 4);

-- Who the invoice is for (place of supply for GST).
CREATE TABLE billing_profiles (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  legal_name  text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  country     text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  state       text CHECK (state ~ '^[A-Z]{2}$'),
  gstin       text CHECK (gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (country <> 'IN' OR state IS NOT NULL),
  CHECK (country = 'IN' OR (state IS NULL AND gstin IS NULL))
);

CREATE TABLE billing_subscriptions (
  id                    uuid PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan_code             text NOT NULL REFERENCES billing_plans (code),
  provider              text NOT NULL CHECK (provider IN ('razorpay', 'stripe')),
  -- Known once the provider has created it (Stripe: after checkout; Razorpay: at once).
  provider_ref          text,
  -- The hosted checkout (Stripe session id; Razorpay subscription id).
  checkout_ref          text NOT NULL,
  status                text NOT NULL CHECK (status IN ('incomplete', 'active', 'past_due', 'canceled')),
  provider_status       text NOT NULL,
  cancel_at_period_end  boolean NOT NULL DEFAULT false,
  current_period_start  timestamptz,
  current_period_end    timestamptz,
  -- When a renewal first failed: the 7-day grace runs from here.
  past_due_since        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  UNIQUE (provider, provider_ref)
);
-- At most one paid subscription in force per account.
CREATE UNIQUE INDEX billing_subscriptions_live_idx
  ON billing_subscriptions (user_id) WHERE status IN ('active', 'past_due');
CREATE INDEX billing_subscriptions_user_idx ON billing_subscriptions (user_id, created_at DESC);

-- Webhook idempotency: each provider event is applied once. No payload is kept.
CREATE TABLE billing_events (
  provider         text NOT NULL CHECK (provider IN ('razorpay', 'stripe')),
  event_id         text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255),
  type             text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
  subscription_id  uuid REFERENCES billing_subscriptions (id) ON DELETE SET NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- Tax invoices (GST): consecutive numbers per financial year, issued for each payment.
CREATE TABLE billing_invoice_counters (
  financial_year  text PRIMARY KEY CHECK (financial_year ~ '^\d{4}-\d{2}$'),
  last_number     integer NOT NULL CHECK (last_number >= 0)
);
CREATE TABLE billing_invoices (
  id               uuid PRIMARY KEY,
  number           text NOT NULL UNIQUE CHECK (length(number) <= 16),
  user_id          uuid REFERENCES users (id) ON DELETE SET NULL,
  subscription_id  uuid REFERENCES billing_subscriptions (id) ON DELETE SET NULL,
  provider         text NOT NULL CHECK (provider IN ('razorpay', 'stripe')),
  -- The provider's payment (Razorpay) or invoice (Stripe): one tax invoice per payment.
  payment_ref      text NOT NULL,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  plan_code        text NOT NULL,
  plan_name        text NOT NULL,
  period_start     timestamptz,
  period_end       timestamptz,
  currency         text NOT NULL CHECK (currency IN ('INR', 'USD')),
  total_minor      integer NOT NULL CHECK (total_minor >= 0),
  taxable_minor    integer NOT NULL CHECK (taxable_minor >= 0),
  cgst_minor       integer NOT NULL DEFAULT 0 CHECK (cgst_minor >= 0),
  sgst_minor       integer NOT NULL DEFAULT 0 CHECK (sgst_minor >= 0),
  igst_minor       integer NOT NULL DEFAULT 0 CHECK (igst_minor >= 0),
  tax_note         text NOT NULL,
  sac_code         text NOT NULL,
  refunded_minor   integer NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= total_minor),
  buyer_name       text NOT NULL,
  buyer_country    text NOT NULL,
  buyer_state      text,
  buyer_gstin      text,
  seller_name      text NOT NULL,
  seller_address   text NOT NULL,
  seller_gstin     text,
  seller_state     text NOT NULL,
  UNIQUE (provider, payment_ref),
  CHECK (taxable_minor + cgst_minor + sgst_minor + igst_minor = total_minor)
);
CREATE INDEX billing_invoices_user_idx ON billing_invoices (user_id, issued_at DESC);

-- Entitlements: the tier an account has and until when (the entitlements module).
CREATE TABLE account_tiers (
  user_id          uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  tier             text NOT NULL CHECK (tier IN ('premium', 'creator', 'business')),
  valid_until      timestamptz NOT NULL,
  subscription_id  uuid NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO feature_flags (key, description, kind, enabled, rollout_percent) VALUES
  ('billing', 'New subscriptions (checkout); existing subscriptions are unaffected', 'product', true, 100);

-- Paid plans allow attachments up to 1 GiB before encryption (`media.max_file_bytes`); the
-- per-account limit is enforced by the API, this is the absolute cap (1 GiB of ciphertext and
-- its framing, rounded up to 1.25 GiB).
ALTER TABLE media_blobs DROP CONSTRAINT media_blobs_size_check;
ALTER TABLE media_blobs ADD CONSTRAINT media_blobs_size_check CHECK (size > 0 AND size <= 1342177280);
