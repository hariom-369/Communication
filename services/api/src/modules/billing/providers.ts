import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppError } from '@tessera/platform';
import type { Currency, Provider, SubscriptionStatus } from '@tessera/validation';
import { z } from 'zod';

/**
 * Payment providers behind one interface (ADR-024): Razorpay for India (UPI Autopay, cards,
 * e-mandates), Stripe elsewhere. People pay on the provider's hosted page, so card and UPI details
 * never reach Tessera (PCI DSS SAQ-A). Webhooks are verified with the provider's documented
 * signature scheme (HMAC-SHA256 over the raw body; Stripe also signs a timestamp), compared in
 * constant time. Subscription state is always re-read from the provider's API, so the order in
 * which webhooks arrive does not matter.
 */

export interface ProviderSubscription {
  readonly ref: string;
  readonly status: SubscriptionStatus;
  /** The provider's own status word, kept for support. */
  readonly providerStatus: string;
  /** `undefined`: the provider does not report it (we keep our own record). */
  readonly cancelAtPeriodEnd: boolean | undefined;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  /** Our subscription id, as stored in the provider's metadata at checkout. */
  readonly tesseraId: string | null;
}

export type ProviderEvent =
  | {
      readonly kind: 'subscription';
      readonly eventId: string;
      readonly type: string;
      readonly subscriptionRef: string;
      readonly tesseraId: string | null;
    }
  | {
      readonly kind: 'payment';
      readonly eventId: string;
      readonly type: string;
      readonly subscriptionRef: string;
      readonly tesseraId: string | null;
      readonly payment: {
        readonly ref: string;
        readonly amountMinor: number;
        readonly currency: Currency;
        readonly periodStart: Date | null;
        readonly periodEnd: Date | null;
      };
    }
  | {
      readonly kind: 'refund';
      readonly eventId: string;
      readonly type: string;
      /** The payment the tax invoice was issued for. */
      readonly paymentRef: string;
      /** Total refunded on that payment so far. */
      readonly refundedMinor: number;
    }
  | { readonly kind: 'ignored'; readonly eventId: string; readonly type: string };

export interface CheckoutInput {
  readonly tesseraId: string;
  readonly userId: string;
  readonly priceRef: string;
  readonly interval: 'month' | 'year';
  readonly returnUrl: string;
}

export interface PaymentProvider {
  readonly name: Provider;
  readonly currency: Currency;
  /** Whether an undone cancellation can be undone again (Stripe yes, Razorpay no). */
  readonly canResume: boolean;
  /** The provider's price/plan id for one of our plans, if this provider sells it. */
  priceRef(planCode: string): string | undefined;
  checkout(
    input: CheckoutInput,
  ): Promise<{ checkoutRef: string; providerRef: string | null; url: string }>;
  fetchSubscription(ref: string): Promise<ProviderSubscription>;
  cancelAtPeriodEnd(ref: string): Promise<void>;
  resume(ref: string): Promise<void>;
  cancelNow(ref: string): Promise<void>;
  /** Verifies and decodes a webhook delivery; throws BAD_REQUEST when it is not genuine. */
  parseWebhook(
    raw: Buffer,
    header: (name: string) => string | undefined,
    now?: Date,
  ): ProviderEvent;
}

type Fetch = typeof fetch;

const TIMEOUT_MS = 10_000;

function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function equalHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(given, 'hex');
  return given.length === expected.length && a.length === b.length && timingSafeEqual(a, b);
}

const notGenuine = (): AppError => new AppError('BAD_REQUEST', { detail: 'Invalid signature.' });

function seconds(value: number | null | undefined): Date | null {
  return value === null || value === undefined || value === 0 ? null : new Date(value * 1000);
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError('BAD_REQUEST', { detail: 'Not JSON.' });
  }
}

async function call(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  what: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new AppError('SERVICE_UNAVAILABLE', {
      detail: 'The payment provider cannot be reached.',
    });
  }
  const text = await response.text();
  if (!response.ok)
    // The provider's error body may contain identifiers; it is not passed on.
    throw new AppError('SERVICE_UNAVAILABLE', {
      detail: `The payment provider refused the request (${what}).`,
    });
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('SERVICE_UNAVAILABLE', {
      detail: 'Unexpected answer from the payment provider.',
    });
  }
}

/** Parses `plan=price,plan=price` configuration. */
export function parsePriceMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (value ?? '').split(',')) {
    const [plan, ref] = entry.split('=').map((part) => part.trim());
    if (plan !== undefined && plan !== '' && ref !== undefined && ref !== '') map.set(plan, ref);
  }
  return map;
}

// ---- Stripe --------------------------------------------------------------------------------------

/** Pinned so the response shapes below stay valid (Stripe-Version header). */
export const STRIPE_API_VERSION = '2024-06-20';
const STRIPE_TOLERANCE_SECONDS = 300;

const stripeSubscription = z.object({
  id: z.string(),
  status: z.string(),
  cancel_at_period_end: z.boolean(),
  current_period_start: z.number().nullish(),
  current_period_end: z.number().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
});
const stripeEvent = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

/** Stripe subscription status → ours (docs/billing.md §3). */
export function stripeStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'paused':
      return 'past_due';
    case 'incomplete':
      return 'incomplete';
    default:
      return 'canceled'; // canceled, incomplete_expired
  }
}

/** Stripe's form encoding (`a[b][c]=v`). */
type FormValue = string | number | boolean | undefined | { readonly [key: string]: FormValue };

function stripeForm(values: Readonly<Record<string, FormValue>>, prefix = ''): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const name = prefix === '' ? key : `${prefix}[${key}]`;
    if (value === undefined) continue;
    if (typeof value === 'object') {
      parts.push(...stripeForm(value, name));
      continue;
    }
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parts;
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  readonly currency = 'USD' as const;
  readonly canResume = true;
  readonly #secretKey: string;
  readonly #webhookSecret: string;
  readonly #prices: Map<string, string>;
  readonly #apiUrl: string;
  readonly #fetch: Fetch;

  constructor(config: {
    secretKey: string;
    webhookSecret: string;
    prices: Map<string, string>;
    apiUrl: string;
    fetch?: Fetch;
  }) {
    this.#secretKey = config.secretKey;
    this.#webhookSecret = config.webhookSecret;
    this.#prices = config.prices;
    this.#apiUrl = config.apiUrl.replace(/\/$/, '');
    this.#fetch = config.fetch ?? fetch;
  }

  priceRef(planCode: string): string | undefined {
    return this.#prices.get(planCode);
  }

  #request(
    method: 'GET' | 'POST',
    path: string,
    body?: Readonly<Record<string, FormValue>>,
  ): Promise<unknown> {
    return call(
      this.#fetch,
      `${this.#apiUrl}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.#secretKey}`,
          'stripe-version': STRIPE_API_VERSION,
          ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
        },
        ...(body === undefined ? {} : { body: stripeForm(body).join('&') }),
      },
      path.split('/')[2] ?? 'request',
    );
  }

  async checkout(
    input: CheckoutInput,
  ): Promise<{ checkoutRef: string; providerRef: string | null; url: string }> {
    const metadata = { tessera_subscription_id: input.tesseraId };
    const session = z.object({ id: z.string(), url: z.string() }).parse(
      await this.#request('POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        line_items: { 0: { price: input.priceRef, quantity: 1 } },
        success_url: input.returnUrl,
        cancel_url: input.returnUrl,
        client_reference_id: input.tesseraId,
        metadata,
        subscription_data: { metadata },
      }),
    );
    return { checkoutRef: session.id, providerRef: null, url: session.url };
  }

  async fetchSubscription(ref: string): Promise<ProviderSubscription> {
    const sub = stripeSubscription.parse(
      await this.#request('GET', `/v1/subscriptions/${encodeURIComponent(ref)}`),
    );
    return {
      ref: sub.id,
      status: stripeStatus(sub.status),
      providerStatus: sub.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      periodStart: seconds(sub.current_period_start),
      periodEnd: seconds(sub.current_period_end),
      tesseraId: sub.metadata?.['tessera_subscription_id'] ?? null,
    };
  }

  async cancelAtPeriodEnd(ref: string): Promise<void> {
    await this.#request('POST', `/v1/subscriptions/${encodeURIComponent(ref)}`, {
      cancel_at_period_end: true,
    });
  }

  async resume(ref: string): Promise<void> {
    await this.#request('POST', `/v1/subscriptions/${encodeURIComponent(ref)}`, {
      cancel_at_period_end: false,
    });
  }

  async cancelNow(ref: string): Promise<void> {
    await call(
      this.#fetch,
      `${this.#apiUrl}/v1/subscriptions/${encodeURIComponent(ref)}`,
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${this.#secretKey}`,
          'stripe-version': STRIPE_API_VERSION,
        },
      },
      'subscriptions',
    );
  }

  parseWebhook(
    raw: Buffer,
    header: (name: string) => string | undefined,
    now = new Date(),
  ): ProviderEvent {
    // Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…] over "<t>.<raw body>".
    const fields = (header('stripe-signature') ?? '').split(',').map((part) => part.split('='));
    const timestamp = Number(fields.find(([key]) => key === 't')?.[1]);
    const signatures = fields.filter(([key]) => key === 'v1').map(([, value]) => value ?? '');
    if (!Number.isInteger(timestamp) || signatures.length === 0) throw notGenuine();
    if (Math.abs(now.getTime() / 1000 - timestamp) > STRIPE_TOLERANCE_SECONDS) throw notGenuine();
    const expected = hmacHex(this.#webhookSecret, `${String(timestamp)}.${raw.toString('utf8')}`);
    if (!signatures.some((signature) => equalHex(expected, signature))) throw notGenuine();

    const event = stripeEvent.parse(parseJson(raw));
    const object = event.data.object;
    const str = (value: unknown) => (typeof value === 'string' ? value : null);
    const metadataId = (value: unknown) =>
      str((value as Record<string, unknown> | null | undefined)?.['tessera_subscription_id']);
    const base = { eventId: event.id, type: event.type };
    switch (event.type) {
      case 'checkout.session.completed': {
        const ref = str(object['subscription']);
        return ref === null
          ? { kind: 'ignored', ...base }
          : {
              kind: 'subscription',
              ...base,
              subscriptionRef: ref,
              tesseraId: metadataId(object['metadata']),
            };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        const ref = str(object['id']);
        return ref === null
          ? { kind: 'ignored', ...base }
          : {
              kind: 'subscription',
              ...base,
              subscriptionRef: ref,
              tesseraId: metadataId(object['metadata']),
            };
      }
      case 'invoice.payment_failed': {
        const ref = str(object['subscription']);
        return ref === null
          ? { kind: 'ignored', ...base }
          : { kind: 'subscription', ...base, subscriptionRef: ref, tesseraId: null };
      }
      case 'invoice.paid': {
        const ref = str(object['subscription']);
        const invoice = z
          .object({
            id: z.string(),
            amount_paid: z.number().int().nonnegative(),
            currency: z.string(),
            lines: z
              .object({
                data: z.array(
                  z.object({ period: z.object({ start: z.number(), end: z.number() }).nullish() }),
                ),
              })
              .nullish(),
          })
          .parse(object);
        const currency = invoice.currency.toUpperCase();
        if (ref === null || (currency !== 'USD' && currency !== 'INR'))
          return { kind: 'ignored', ...base };
        const period = invoice.lines?.data[0]?.period;
        return {
          kind: 'payment',
          ...base,
          subscriptionRef: ref,
          tesseraId: null,
          payment: {
            ref: invoice.id,
            amountMinor: invoice.amount_paid,
            currency,
            periodStart: seconds(period?.start),
            periodEnd: seconds(period?.end),
          },
        };
      }
      case 'charge.refunded': {
        const invoiceRef = str(object['invoice']);
        const refunded = object['amount_refunded'];
        return invoiceRef === null || typeof refunded !== 'number'
          ? { kind: 'ignored', ...base }
          : { kind: 'refund', ...base, paymentRef: invoiceRef, refundedMinor: refunded };
      }
      default:
        return { kind: 'ignored', ...base };
    }
  }
}

// ---- Razorpay ----------------------------------------------------------------------------------

const razorpaySubscription = z.object({
  id: z.string(),
  status: z.string(),
  current_start: z.number().nullish(),
  current_end: z.number().nullish(),
  notes: z.union([z.record(z.string(), z.string()), z.array(z.unknown())]).nullish(),
});
const razorpayEvent = z.object({
  event: z.string(),
  payload: z.record(z.string(), z.object({ entity: z.record(z.string(), z.unknown()) })),
});

/** Razorpay subscription status → ours (docs/billing.md §3). */
export function razorpayStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'pending': // a charge failed; Razorpay retries
    case 'halted': // retries exhausted; the grace period decides
      return 'past_due';
    case 'created':
    case 'authenticated':
      return 'incomplete';
    default:
      return 'canceled'; // cancelled, completed, expired, paused
  }
}

function notesId(notes: unknown): string | null {
  if (notes === null || typeof notes !== 'object' || Array.isArray(notes)) return null;
  const value = (notes as Record<string, unknown>)['tessera_subscription_id'];
  return typeof value === 'string' ? value : null;
}

export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  readonly currency = 'INR' as const;
  readonly canResume = false;
  readonly #keyId: string;
  readonly #keySecret: string;
  readonly #webhookSecret: string;
  readonly #plans: Map<string, string>;
  readonly #apiUrl: string;
  readonly #fetch: Fetch;

  constructor(config: {
    keyId: string;
    keySecret: string;
    webhookSecret: string;
    plans: Map<string, string>;
    apiUrl: string;
    fetch?: Fetch;
  }) {
    this.#keyId = config.keyId;
    this.#keySecret = config.keySecret;
    this.#webhookSecret = config.webhookSecret;
    this.#plans = config.plans;
    this.#apiUrl = config.apiUrl.replace(/\/$/, '');
    this.#fetch = config.fetch ?? fetch;
  }

  priceRef(planCode: string): string | undefined {
    return this.#plans.get(planCode);
  }

  #request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<unknown> {
    return call(
      this.#fetch,
      `${this.#apiUrl}${path}`,
      {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.#keyId}:${this.#keySecret}`).toString('base64')}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      path.split('/')[2] ?? 'request',
    );
  }

  async checkout(
    input: CheckoutInput,
  ): Promise<{ checkoutRef: string; providerRef: string | null; url: string }> {
    const sub = z.object({ id: z.string(), short_url: z.string() }).parse(
      await this.#request('POST', '/v1/subscriptions', {
        plan_id: input.priceRef,
        // Razorpay needs a number of billing cycles: ten years either way.
        total_count: input.interval === 'month' ? 120 : 10,
        quantity: 1,
        customer_notify: 1,
        notes: { tessera_subscription_id: input.tesseraId },
      }),
    );
    return { checkoutRef: sub.id, providerRef: sub.id, url: sub.short_url };
  }

  async fetchSubscription(ref: string): Promise<ProviderSubscription> {
    const sub = razorpaySubscription.parse(
      await this.#request('GET', `/v1/subscriptions/${encodeURIComponent(ref)}`),
    );
    return {
      ref: sub.id,
      status: razorpayStatus(sub.status),
      providerStatus: sub.status,
      cancelAtPeriodEnd: undefined,
      periodStart: seconds(sub.current_start),
      periodEnd: seconds(sub.current_end),
      tesseraId: notesId(sub.notes),
    };
  }

  async cancelAtPeriodEnd(ref: string): Promise<void> {
    await this.#request('POST', `/v1/subscriptions/${encodeURIComponent(ref)}/cancel`, {
      cancel_at_cycle_end: 1,
    });
  }

  resume(): Promise<void> {
    return Promise.reject(
      new AppError('CONFLICT', {
        detail: 'This cancellation cannot be undone. Subscribe again when the plan ends.',
      }),
    );
  }

  async cancelNow(ref: string): Promise<void> {
    await this.#request('POST', `/v1/subscriptions/${encodeURIComponent(ref)}/cancel`, {
      cancel_at_cycle_end: 0,
    });
  }

  parseWebhook(raw: Buffer, header: (name: string) => string | undefined): ProviderEvent {
    // X-Razorpay-Signature: hex HMAC-SHA256 of the raw body with the webhook secret.
    const signature = header('x-razorpay-signature') ?? '';
    if (!equalHex(hmacHex(this.#webhookSecret, raw), signature)) throw notGenuine();
    // Razorpay's delivery id: the same for every retry of one event.
    const eventId = header('x-razorpay-event-id');
    if (eventId === undefined || eventId === '' || eventId.length > 255) throw notGenuine();
    const event = razorpayEvent.parse(parseJson(raw));
    const base = { eventId, type: event.event };
    const subscription = event.payload['subscription']?.entity;
    const payment = event.payload['payment']?.entity;
    const ref = typeof subscription?.['id'] === 'string' ? subscription['id'] : null;
    if (event.event === 'refund.processed') {
      const refund = event.payload['refund']?.entity;
      const paymentRef = refund?.['payment_id'];
      const total = payment?.['amount_refunded'];
      return typeof paymentRef === 'string' && typeof total === 'number'
        ? { kind: 'refund', ...base, paymentRef, refundedMinor: total }
        : { kind: 'ignored', ...base };
    }
    if (!event.event.startsWith('subscription.') || ref === null)
      return { kind: 'ignored', ...base };
    const tesseraId = notesId(subscription?.['notes']);
    if (event.event === 'subscription.charged' && payment !== undefined) {
      const charged = z
        .object({
          id: z.string(),
          amount: z.number().int().nonnegative(),
          currency: z.literal('INR'),
        })
        .safeParse(payment);
      if (!charged.success) return { kind: 'ignored', ...base };
      const toDate = (value: unknown) => (typeof value === 'number' ? seconds(value) : null);
      return {
        kind: 'payment',
        ...base,
        subscriptionRef: ref,
        tesseraId,
        payment: {
          ref: charged.data.id,
          amountMinor: charged.data.amount,
          currency: 'INR',
          periodStart: toDate(subscription?.['current_start']),
          periodEnd: toDate(subscription?.['current_end']),
        },
      };
    }
    return { kind: 'subscription', ...base, subscriptionRef: ref, tesseraId };
  }
}
