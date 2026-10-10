import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * A stand-in for Stripe's and Razorpay's APIs and hosted checkout pages, for tests (integration
 * and E2E). It implements the endpoints the billing adapters call, checks their credentials, and
 * produces webhook deliveries signed exactly as each provider documents (Stripe: `t=…,v1=…` over
 * "<t>.<body>"; Razorpay: hex HMAC of the body plus an event id header). The test decides when a
 * payment succeeds, fails, renews, ends or is refunded. Test-only — never shipped.
 */

export interface Delivery {
  readonly provider: 'stripe' | 'razorpay';
  readonly body: string;
  readonly headers: Record<string, string>;
}

interface Price {
  readonly amountMinor: number;
  readonly currency: 'INR' | 'USD';
  readonly interval: 'month' | 'year';
}

interface Sub {
  readonly provider: 'stripe' | 'razorpay';
  readonly id: string;
  status: string;
  priceRef: string;
  metadata: Record<string, string>;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
}

interface StripeSession {
  readonly id: string;
  readonly priceRef: string;
  readonly metadata: Record<string, string>;
  readonly successUrl: string;
  subscription: string | null;
}

const DAY = 86_400;

/** Credentials the stand-in accepts and signs with: random per run, never real keys. */
export interface StandInCredentials {
  readonly stripeSecretKey: string;
  readonly stripeWebhookSecret: string;
  readonly razorpayKeyId: string;
  readonly razorpayKeySecret: string;
  readonly razorpayWebhookSecret: string;
}

export function freshCredentials(): StandInCredentials {
  const random = () => randomBytes(18).toString('base64url');
  return {
    // Test-mode prefixes, which production configuration refuses.
    stripeSecretKey: `sk_test_${random()}`,
    stripeWebhookSecret: `whsec_${random()}`,
    razorpayKeyId: `rzp_test_${randomBytes(6).toString('hex')}`,
    razorpayKeySecret: random(),
    razorpayWebhookSecret: random(),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (data += chunk));
    request.on('end', () => {
      resolve(data);
    });
    request.on('error', reject);
  });
}

/** Stripe's bracketed form encoding → nested object. */
function parseForm(body: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const path = key.replace(/\]/g, '').split('[');
    let node = result;
    for (const [index, part] of path.entries()) {
      if (index === path.length - 1) node[part] = value;
      else node = (node[part] ??= {}) as Record<string, unknown>;
    }
  }
  return result;
}

const id = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;

export class FakePayments {
  readonly prices = new Map<string, Price>([
    ['price_premium_monthly', { amountMinor: 299, currency: 'USD', interval: 'month' }],
    ['price_premium_yearly', { amountMinor: 2999, currency: 'USD', interval: 'year' }],
    ['price_creator_monthly', { amountMinor: 699, currency: 'USD', interval: 'month' }],
    ['plan_premium_monthly', { amountMinor: 9900, currency: 'INR', interval: 'month' }],
    ['plan_premium_yearly', { amountMinor: 99900, currency: 'INR', interval: 'year' }],
    ['plan_creator_monthly', { amountMinor: 29900, currency: 'INR', interval: 'month' }],
  ]);
  /** Where hosted checkout sends people back to (Razorpay links have no return address). */
  razorpayReturnUrl = 'http://localhost:4173/settings/plan?checkout=return';
  /** Where deliveries go when not collected by the test (E2E: the API's webhook URLs). */
  webhookBase: string | null = null;
  readonly sent: Delivery[] = [];
  readonly #subs = new Map<string, Sub>();
  readonly #sessions = new Map<string, StripeSession>();
  readonly #razorpayPending = new Map<string, Sub>();
  #clock = Math.floor(Date.now() / 1000);

  readonly server: Server;
  readonly url: string;
  readonly credentials: StandInCredentials;

  // No parameter properties: the E2E runner loads this file with Node's type stripping.
  private constructor(server: Server, url: string, credentials: StandInCredentials) {
    this.server = server;
    this.url = url;
    this.credentials = credentials;
  }

  static async start(
    port = 0,
    credentials: StandInCredentials = freshCredentials(),
  ): Promise<FakePayments> {
    const holder: { fake?: FakePayments } = {};
    const server = createServer((request, response) => {
      void (
        holder.fake === undefined
          ? Promise.reject(new Error('starting'))
          : holder.fake.handle(request)
      ).then(
        ({ status, headers, body }) => {
          response.writeHead(status, headers);
          response.end(body);
        },
        () => {
          response.writeHead(500);
          response.end();
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const fake = new FakePayments(server, `http://127.0.0.1:${String(address.port)}`, credentials);
    holder.fake = fake;
    return fake;
  }

  close(): Promise<void> {
    return new Promise((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  /** Moves the provider's clock (periods are computed from it). */
  advance(seconds: number): void {
    this.#clock += seconds;
  }

  subscription(ref: string): Sub | undefined {
    return this.#subs.get(ref) ?? this.#razorpayPending.get(ref);
  }

  stripeSubscriptionOf(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.subscription ?? null;
  }

  // ---- signing --------------------------------------------------------------------------------

  stripeDelivery(
    event: Record<string, unknown>,
    options: { timestamp?: number; secret?: string } = {},
  ): Delivery {
    const body = JSON.stringify(event);
    const t = options.timestamp ?? Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', options.secret ?? this.credentials.stripeWebhookSecret)
      .update(`${String(t)}.${body}`)
      .digest('hex');
    return {
      provider: 'stripe',
      body,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'stripe-signature': `t=${String(t)},v1=${signature}`,
      },
    };
  }

  razorpayDelivery(
    event: Record<string, unknown>,
    options: { eventId?: string; secret?: string } = {},
  ): Delivery {
    const body = JSON.stringify(event);
    const signature = createHmac('sha256', options.secret ?? this.credentials.razorpayWebhookSecret)
      .update(body)
      .digest('hex');
    return {
      provider: 'razorpay',
      body,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': options.eventId ?? id('evt'),
      },
    };
  }

  #stripeSubObject(sub: Sub): Record<string, unknown> {
    return {
      id: sub.id,
      object: 'subscription',
      status: sub.status,
      cancel_at_period_end: sub.cancelAtPeriodEnd,
      current_period_start: sub.periodStart,
      current_period_end: sub.periodEnd,
      metadata: sub.metadata,
      items: { data: [{ price: { id: sub.priceRef } }] },
    };
  }

  #razorpaySubObject(sub: Sub): Record<string, unknown> {
    return {
      id: sub.id,
      entity: 'subscription',
      plan_id: sub.priceRef,
      status: sub.status,
      current_start: sub.status === 'created' ? null : sub.periodStart,
      current_end: sub.status === 'created' ? null : sub.periodEnd,
      notes: sub.metadata,
      short_url: `${this.url}/checkout/razorpay/${sub.id}`,
    };
  }

  #stripeEvent(type: string, object: Record<string, unknown>): Delivery {
    return this.stripeDelivery({ id: id('evt'), object: 'event', type, data: { object } });
  }

  #razorpayEvent(event: string, payload: Record<string, unknown>): Delivery {
    const wrapped: Record<string, { entity: unknown }> = {};
    for (const [key, entity] of Object.entries(payload)) wrapped[key] = { entity };
    return this.razorpayDelivery({
      entity: 'event',
      event,
      payload: wrapped,
      created_at: this.#clock,
    });
  }

  #period(priceRef: string): number {
    return (this.prices.get(priceRef)?.interval ?? 'month') === 'year' ? 365 * DAY : 30 * DAY;
  }

  #invoicePaid(sub: Sub): Delivery {
    const price = this.prices.get(sub.priceRef);
    return this.#stripeEvent('invoice.paid', {
      id: id('in'),
      object: 'invoice',
      subscription: sub.id,
      amount_paid: price?.amountMinor ?? 0,
      currency: (price?.currency ?? 'USD').toLowerCase(),
      lines: { data: [{ period: { start: sub.periodStart, end: sub.periodEnd } }] },
    });
  }

  #charged(sub: Sub): Delivery {
    const price = this.prices.get(sub.priceRef);
    return this.#razorpayEvent('subscription.charged', {
      subscription: this.#razorpaySubObject(sub),
      payment: {
        id: id('pay'),
        entity: 'payment',
        amount: price?.amountMinor ?? 0,
        currency: 'INR',
        status: 'captured',
      },
    });
  }

  // ---- what the test makes happen (each returns the webhook deliveries, in provider order) ----

  /** The person pays on the hosted page: the subscription starts. */
  pay(checkoutRef: string): Delivery[] {
    const session = this.#sessions.get(checkoutRef);
    if (session !== undefined) {
      const sub: Sub = {
        provider: 'stripe',
        id: id('sub'),
        status: 'active',
        priceRef: session.priceRef,
        metadata: session.metadata,
        periodStart: this.#clock,
        periodEnd: this.#clock + this.#period(session.priceRef),
        cancelAtPeriodEnd: false,
      };
      this.#subs.set(sub.id, sub);
      session.subscription = sub.id;
      return [
        this.#stripeEvent('checkout.session.completed', {
          id: session.id,
          object: 'checkout.session',
          subscription: sub.id,
          metadata: session.metadata,
        }),
        this.#stripeEvent('customer.subscription.created', this.#stripeSubObject(sub)),
        this.#invoicePaid(sub),
      ];
    }
    const pending = this.#razorpayPending.get(checkoutRef);
    if (pending === undefined) throw new Error(`no checkout ${checkoutRef}`);
    this.#razorpayPending.delete(checkoutRef);
    pending.status = 'active';
    pending.periodStart = this.#clock;
    pending.periodEnd = this.#clock + this.#period(pending.priceRef);
    this.#subs.set(pending.id, pending);
    return [
      this.#razorpayEvent('subscription.authenticated', {
        subscription: this.#razorpaySubObject(pending),
      }),
      this.#razorpayEvent('subscription.activated', {
        subscription: this.#razorpaySubObject(pending),
      }),
      this.#charged(pending),
    ];
  }

  #sub(ref: string): Sub {
    const sub = this.#subs.get(ref);
    if (sub === undefined) throw new Error(`no subscription ${ref}`);
    return sub;
  }

  /** The next period is charged successfully. */
  renew(ref: string): Delivery[] {
    const sub = this.#sub(ref);
    sub.status = 'active';
    sub.periodStart = sub.periodEnd;
    sub.periodEnd = sub.periodStart + this.#period(sub.priceRef);
    return sub.provider === 'stripe'
      ? [
          this.#stripeEvent('customer.subscription.updated', this.#stripeSubObject(sub)),
          this.#invoicePaid(sub),
        ]
      : [this.#charged(sub)];
  }

  /** The renewal charge fails (the provider will retry). */
  failRenewal(ref: string): Delivery[] {
    const sub = this.#sub(ref);
    sub.periodStart = sub.periodEnd;
    sub.periodEnd = sub.periodStart + this.#period(sub.priceRef);
    if (sub.provider === 'stripe') {
      sub.status = 'past_due';
      return [
        this.#stripeEvent('invoice.payment_failed', {
          id: id('in'),
          object: 'invoice',
          subscription: sub.id,
        }),
        this.#stripeEvent('customer.subscription.updated', this.#stripeSubObject(sub)),
      ];
    }
    sub.status = 'pending';
    return [
      this.#razorpayEvent('subscription.pending', { subscription: this.#razorpaySubObject(sub) }),
    ];
  }

  /** The subscription ends (period over after a cancellation, or retries exhausted). */
  end(ref: string): Delivery[] {
    const sub = this.#sub(ref);
    if (sub.provider === 'stripe') {
      sub.status = 'canceled';
      return [this.#stripeEvent('customer.subscription.deleted', this.#stripeSubObject(sub))];
    }
    sub.status = 'cancelled';
    return [
      this.#razorpayEvent('subscription.cancelled', { subscription: this.#razorpaySubObject(sub) }),
    ];
  }

  /** A refund of a payment (total refunded so far). */
  refund(
    provider: 'stripe' | 'razorpay',
    paymentRef: string,
    totalRefundedMinor: number,
  ): Delivery[] {
    return provider === 'stripe'
      ? [
          this.#stripeEvent('charge.refunded', {
            id: id('ch'),
            object: 'charge',
            invoice: paymentRef,
            amount_refunded: totalRefundedMinor,
          }),
        ]
      : [
          this.#razorpayEvent('refund.processed', {
            refund: {
              id: id('rfnd'),
              entity: 'refund',
              payment_id: paymentRef,
              amount: totalRefundedMinor,
            },
            payment: { id: paymentRef, entity: 'payment', amount_refunded: totalRefundedMinor },
          }),
        ];
  }

  /** Sends deliveries to `webhookBase` (E2E). */
  async deliver(deliveries: readonly Delivery[]): Promise<void> {
    for (const delivery of deliveries) {
      this.sent.push(delivery);
      if (this.webhookBase === null) continue;
      await fetch(`${this.webhookBase}/${delivery.provider}`, {
        method: 'POST',
        headers: delivery.headers,
        body: delivery.body,
      });
    }
  }

  // ---- the provider APIs --------------------------------------------------------------------

  async handle(
    request: IncomingMessage,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const url = new URL(request.url ?? '/', this.url);
    const json = (status: number, value: unknown) => ({
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    const body = request.method === 'GET' ? '' : await readBody(request);
    const path = url.pathname;

    // Hosted checkout (E2E): a page with a pay button, as the providers' pages have.
    const checkout = /^\/checkout\/(stripe|razorpay)\/([\w-]+)(\/pay)?$/.exec(path);
    if (checkout !== null) {
      const [, provider, ref = '', pay] = checkout;
      if (pay === undefined)
        return {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "default-src 'none'; form-action *",
          },
          body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test payment page</title></head><body><main><h1>Test payment page (${String(provider)})</h1><form method="post" action="/checkout/${String(provider)}/${ref}/pay"><button type="submit">Pay</button></form></main></body></html>`,
        };
      const back =
        provider === 'stripe'
          ? (this.#sessions.get(ref)?.successUrl ?? '/')
          : this.razorpayReturnUrl;
      await this.deliver(this.pay(ref));
      return { status: 303, headers: { location: back }, body: '' };
    }

    if (path.startsWith('/v1/') && request.headers['stripe-version'] !== undefined) {
      if (request.headers.authorization !== `Bearer ${this.credentials.stripeSecretKey}`)
        return json(401, { error: { type: 'invalid_request_error' } });
      if (path === '/v1/checkout/sessions' && request.method === 'POST') {
        const form = parseForm(body) as {
          mode?: string;
          line_items?: Record<string, { price?: string }>;
          success_url?: string;
          metadata?: Record<string, string>;
          subscription_data?: { metadata?: Record<string, string> };
        };
        const priceRef = form.line_items?.['0']?.price ?? '';
        if (form.mode !== 'subscription' || !this.prices.has(priceRef))
          return json(400, { error: { type: 'invalid_request_error' } });
        const session: StripeSession = {
          id: id('cs_test'),
          priceRef,
          metadata: form.subscription_data?.metadata ?? form.metadata ?? {},
          successUrl: form.success_url ?? '',
          subscription: null,
        };
        this.#sessions.set(session.id, session);
        return json(200, {
          id: session.id,
          object: 'checkout.session',
          url: `${this.url}/checkout/stripe/${session.id}`,
        });
      }
      const match = /^\/v1\/subscriptions\/([\w-]+)$/.exec(path);
      const sub = match?.[1] === undefined ? undefined : this.#subs.get(match[1]);
      if (sub === undefined) return json(404, { error: { type: 'invalid_request_error' } });
      if (request.method === 'POST') {
        const form = parseForm(body);
        if (form['cancel_at_period_end'] !== undefined)
          sub.cancelAtPeriodEnd = form['cancel_at_period_end'] === 'true';
      }
      if (request.method === 'DELETE') sub.status = 'canceled';
      return json(200, this.#stripeSubObject(sub));
    }

    if (path.startsWith('/v1/')) {
      const expected = `Basic ${Buffer.from(`${this.credentials.razorpayKeyId}:${this.credentials.razorpayKeySecret}`).toString('base64')}`;
      if (request.headers.authorization !== expected)
        return json(401, { error: { code: 'BAD_REQUEST_ERROR' } });
      if (path === '/v1/subscriptions' && request.method === 'POST') {
        const input = JSON.parse(body) as {
          plan_id?: string;
          total_count?: number;
          notes?: Record<string, string>;
        };
        if (
          input.plan_id === undefined ||
          !this.prices.has(input.plan_id) ||
          typeof input.total_count !== 'number'
        )
          return json(400, { error: { code: 'BAD_REQUEST_ERROR' } });
        const sub: Sub = {
          provider: 'razorpay',
          id: id('sub'),
          status: 'created',
          priceRef: input.plan_id,
          metadata: input.notes ?? {},
          periodStart: 0,
          periodEnd: 0,
          cancelAtPeriodEnd: false,
        };
        this.#razorpayPending.set(sub.id, sub);
        return json(200, this.#razorpaySubObject(sub));
      }
      const match = /^\/v1\/subscriptions\/([\w-]+)(\/cancel)?$/.exec(path);
      const ref = match?.[1] ?? '';
      const sub = this.#subs.get(ref) ?? this.#razorpayPending.get(ref);
      if (sub === undefined) return json(400, { error: { code: 'BAD_REQUEST_ERROR' } });
      if (match?.[2] !== undefined) {
        const input = JSON.parse(body) as { cancel_at_cycle_end?: number };
        if (input.cancel_at_cycle_end === 1) sub.cancelAtPeriodEnd = true;
        else sub.status = 'cancelled';
      }
      return json(200, this.#razorpaySubObject(sub));
    }
    return json(404, { error: 'not found' });
  }
}
