import { mediaCiphertextSize, TIER_LIMITS } from '@tessera/validation';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakePayments, type Delivery } from '../../test/fake-payments.js';
import {
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';
import { EntitlementsService } from '../entitlements/index.js';

/**
 * Billing (docs/billing.md §6, ADR-051). Exit criteria for Phase 13: **webhook idempotency**
 * (duplicates, concurrent duplicates, retries and out-of-order deliveries all end in the same
 * state, with one effect each; forged and stale deliveries are refused) and **entitlement
 * propagation** (a paid tier reaches media and channels on the next request, and ends on time).
 * Against a stand-in for both providers' APIs that signs webhooks as each provider documents.
 */

let env: IntegrationApp;
let payments: FakePayments;

beforeAll(async () => {
  payments = await FakePayments.start();
  env = await startIntegrationApp({ payments });
});
afterAll(async () => {
  await env.close();
  await payments.close();
});

const DAY = 86_400_000;
const MIB = 1024 * 1024;

async function deliver(delivery: Delivery): Promise<LightMyRequestResponse> {
  return env.app.inject({
    method: 'POST',
    url: `/api/v1/billing/webhooks/${delivery.provider}`,
    headers: delivery.headers,
    payload: delivery.body,
    remoteAddress: '54.187.174.169',
  });
}

async function deliverAll(deliveries: readonly Delivery[]): Promise<void> {
  for (const delivery of deliveries) {
    const response = await deliver(delivery);
    expect(response.statusCode, response.body).toBe(200);
  }
}

const KARNATAKA = { legalName: 'Asha Rao', country: 'IN', state: 'KA', gstin: null };
const MAHARASHTRA = { legalName: 'Ravi Shah', country: 'IN', state: 'MH', gstin: null };
const GERMANY = { legalName: 'Lena Vogel', country: 'DE', state: null, gstin: null };

async function customer(profile: Record<string, unknown> | null = KARNATAKA) {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  if (profile !== null) {
    const saved = await created.client.put('/api/v1/billing/profile', profile);
    expect(saved.statusCode, saved.body).toBe(200);
  }
  return { ...created, id: me.id };
}
type Customer = Awaited<ReturnType<typeof customer>>;

async function checkout(person: Customer, planCode = 'premium_monthly') {
  const response = await person.client.post('/api/v1/billing/checkout', { planCode });
  expect(response.statusCode, response.body).toBe(201);
  const { subscriptionId } = response.json<{ subscriptionId: string; url: string }>();
  const row = await env.db
    .selectFrom('billing_subscriptions')
    .select(['checkout_ref', 'provider'])
    .where('id', '=', subscriptionId)
    .executeTakeFirstOrThrow();
  return { subscriptionId, checkoutRef: row.checkout_ref, provider: row.provider };
}

/** Checks out and pays; returns the provider's subscription id. */
async function subscribe(person: Customer, planCode = 'premium_monthly'): Promise<string> {
  const started = await checkout(person, planCode);
  await deliverAll(payments.pay(started.checkoutRef));
  return (
    payments.stripeSubscriptionOf(started.checkoutRef) ?? started.checkoutRef // Razorpay: same id
  );
}

const tier = async (person: Customer) =>
  (await person.client.get('/api/v1/entitlements')).json<{
    tier: string;
    validUntil: string | null;
    limits: Record<string, number>;
  }>();
const uploadOf = (person: Customer, plaintextBytes: number) =>
  person.client.post('/api/v1/media/uploads', { size: mediaCiphertextSize(plaintextBytes) });

describe("plans and billing details ('billing.plans', 'billing.profile', 'billing.profile_update', 'billing.checkout')", () => {
  it('shows prices in the person’s currency once they say where they are', async () => {
    const nobody = await customer(null);
    const unset = (await nobody.client.get('/api/v1/billing/plans')).json<{
      currency: string | null;
      plans: { available: boolean }[];
    }>();
    expect(unset.currency).toBeNull();
    expect(unset.plans.every((plan) => !plan.available)).toBe(true);

    const india = await customer(KARNATAKA);
    const inr = (await india.client.get('/api/v1/billing/plans')).json<{
      currency: string;
      provider: string;
      plans: {
        code: string;
        price: { currency: string; amountMinor: number };
        available: boolean;
      }[];
    }>();
    expect(inr).toMatchObject({ currency: 'INR', provider: 'razorpay' });
    expect(inr.plans.find((p) => p.code === 'premium_monthly')).toMatchObject({
      price: { currency: 'INR', amountMinor: 9900 },
      available: true,
    });
    // No provider price is configured for Business yet: listed, not purchasable.
    expect(inr.plans.find((p) => p.code === 'business_monthly')?.available).toBe(false);

    const abroad = await customer(GERMANY);
    expect((await abroad.client.get('/api/v1/billing/plans')).json()).toMatchObject({
      currency: 'USD',
      provider: 'stripe',
    });
  });

  it('validates the place of supply and GSTIN', async () => {
    const person = await customer(null);
    const put = (profile: Record<string, unknown>) =>
      person.client.put('/api/v1/billing/profile', profile);
    expect((await put({ ...KARNATAKA, state: null })).statusCode).toBe(400);
    expect((await put({ ...GERMANY, state: 'KA' })).statusCode).toBe(400);
    expect((await put({ ...KARNATAKA, gstin: '29ABCDE1234F1Z' })).statusCode).toBe(400);
    // A GSTIN registered in Maharashtra (27) is not a Karnataka business.
    expect((await put({ ...KARNATAKA, gstin: '27ABCDE1234F1Z5' })).statusCode).toBe(400);
    expect((await put({ ...KARNATAKA, gstin: '29abcde1234f1z5' })).statusCode).toBe(200);
    expect((await person.client.get('/api/v1/billing/profile')).json()).toMatchObject({
      profile: { gstin: '29ABCDE1234F1Z5' },
    });
  });

  it('needs billing details and refuses a second plan', async () => {
    const nobody = await customer(null);
    expect(
      (await nobody.client.post('/api/v1/billing/checkout', { planCode: 'premium_monthly' }))
        .statusCode,
    ).toBe(409);
    const person = await customer();
    await subscribe(person);
    const again = await person.client.post('/api/v1/billing/checkout', {
      planCode: 'creator_monthly',
    });
    expect(again.statusCode).toBe(409);
    // While a plan runs, the billing country (and so the provider) cannot move.
    expect((await person.client.put('/api/v1/billing/profile', GERMANY)).statusCode).toBe(409);
    expect((await person.client.put('/api/v1/billing/profile', MAHARASHTRA)).statusCode).toBe(200);
  });

  it('the billing kill switch pauses new checkouts only', async () => {
    const running = await customer();
    await subscribe(running);
    await env.modules.flags.apply('billing', { enabled: false, rolloutPercent: 0 }, null as never);
    try {
      const person = await customer();
      const refused = await person.client.post('/api/v1/billing/checkout', {
        planCode: 'premium_monthly',
      });
      expect(refused.statusCode).toBe(503);
      expect(
        (await person.client.get('/api/v1/billing/plans'))
          .json<{ plans: { available: boolean }[] }>()
          .plans.every((plan) => !plan.available),
      ).toBe(true);
      expect((await tier(running)).tier).toBe('premium');
    } finally {
      await env.modules.flags.apply(
        'billing',
        { enabled: true, rolloutPercent: 100 },
        null as never,
      );
    }
  });
});

describe("entitlement propagation ('entitlements.mine', 'billing.subscription', 'billing.invoices', 'billing.invoice')", () => {
  it('Razorpay: paying raises the limits on the next request; GST invoice issued', async () => {
    const person = await customer(KARNATAKA);
    // Cached as free first, so propagation has to invalidate it.
    expect((await tier(person)).tier).toBe('free');
    expect((await uploadOf(person, 300 * MIB)).statusCode).toBe(413);

    const started = await checkout(person);
    expect(started.provider).toBe('razorpay');
    const pending = (await person.client.get('/api/v1/billing/subscription')).json<{
      subscription: { status: string };
    }>();
    expect(pending.subscription.status).toBe('incomplete');
    expect((await tier(person)).tier).toBe('free');

    await deliverAll(payments.pay(started.checkoutRef));
    const now = await tier(person);
    expect(now.tier).toBe('premium');
    expect(now.limits['media.max_file_bytes']).toBe(TIER_LIMITS.premium['media.max_file_bytes']);
    expect(new Date(now.validUntil ?? 0).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    expect((await uploadOf(person, 300 * MIB)).statusCode).toBe(201);
    // Beyond the largest plan: refused by validation.
    expect((await uploadOf(person, 1100 * MIB)).statusCode).toBe(400);

    const subscription = (await person.client.get('/api/v1/billing/subscription')).json<{
      subscription: { status: string; planCode: string; cancelAtPeriodEnd: boolean };
    }>();
    expect(subscription.subscription).toMatchObject({
      status: 'active',
      planCode: 'premium_monthly',
      cancelAtPeriodEnd: false,
    });

    const invoices = (await person.client.get('/api/v1/billing/invoices')).json<{
      invoices: {
        id: string;
        number: string;
        totalMinor: number;
        taxableMinor: number;
        cgstMinor: number;
        sgstMinor: number;
        igstMinor: number;
        sacCode: string;
        buyer: { name: string; state: string | null };
        seller: { gstin: string | null };
      }[];
    }>().invoices;
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      totalMinor: 9900,
      taxableMinor: 8390,
      cgstMinor: 755,
      sgstMinor: 755,
      igstMinor: 0,
      sacCode: '998439',
      buyer: { name: 'Asha Rao', state: 'Karnataka' },
      seller: { gstin: '29ABCDE1234F1Z5' },
    });
    expect(invoices[0]?.number).toMatch(/^T\/\d{4}-\d{2}\/\d{6}$/);
    // Someone else's invoice is not reachable.
    const other = await customer();
    expect(
      (await other.client.get(`/api/v1/billing/invoices/${invoices[0]?.id ?? ''}`)).statusCode,
    ).toBe(404);
  });

  it('Stripe: paying abroad (USD); the invoice is a zero-rated export', async () => {
    const person = await customer(GERMANY);
    const started = await checkout(person, 'creator_monthly');
    expect(started.provider).toBe('stripe');
    await deliverAll(payments.pay(started.checkoutRef));
    const now = await tier(person);
    expect(now.tier).toBe('creator');
    const [invoice] = (await person.client.get('/api/v1/billing/invoices')).json<{
      invoices: { currency: string; totalMinor: number; igstMinor: number; taxNote: string }[];
    }>().invoices;
    expect(invoice).toMatchObject({ currency: 'USD', totalMinor: 699, igstMinor: 0 });
    expect(invoice?.taxNote).toMatch(/Export/);
  });

  it('a buyer in another state pays IGST', async () => {
    const person = await customer(MAHARASHTRA);
    await subscribe(person);
    const [invoice] = (await person.client.get('/api/v1/billing/invoices')).json<{
      invoices: { igstMinor: number; cgstMinor: number }[];
    }>().invoices;
    expect(invoice).toMatchObject({ igstMinor: 1510, cgstMinor: 0 });
  });

  it('a Creator plan lifts channel limits for the channel owner', async () => {
    const person = await customer();
    const channel = await person.client.post('/api/v1/channels', {
      handle: `plan_${person.id.slice(-8)}`,
      title: 'Plan test',
      description: '',
      visibility: 'public',
      commentsEnabled: false,
      slowModeSeconds: 0,
    });
    expect(channel.statusCode, channel.body).toBe(201);
    const channelId = channel.json<{ id: string }>().id;
    const schedule = (days: number) =>
      person.client.post(`/api/v1/channels/${channelId}/posts`, {
        body: 'Later',
        previewUrl: null,
        poll: null,
        publish: new Date(Date.now() + days * DAY).toISOString(),
      });
    expect((await schedule(200)).statusCode).toBe(400);
    await subscribe(person, 'creator_monthly');
    expect((await schedule(200)).statusCode).toBe(201);
    expect((await tier(person)).limits['channels.max_owned']).toBe(100);
  });

  it('a cached entry never outlives the tier, and lives at most 60 seconds', async () => {
    const person = await customer();
    await subscribe(person);
    expect((await tier(person)).tier).toBe('premium');
    const key = `${env.keyPrefix}:entitlements:${person.id}`;
    expect(await env.valkey.ttl(key)).toBeLessThanOrEqual(60);
    // Another API process with its own view: the same answer from the shared cache.
    const other = new EntitlementsService(env.db, env.valkey, env.keyPrefix, env.logger);
    expect((await other.forUser(person.id)).tier).toBe('premium');
    // The paid period ends: free at once, even with a cached entry.
    const later = new Date(Date.now() + 40 * DAY);
    expect((await other.forUser(person.id, later)).tier).toBe('free');
  });
});

describe("webhook idempotency ('billing.webhook_razorpay', 'billing.webhook_stripe')", () => {
  it('a duplicate delivery has no second effect', async () => {
    const person = await customer();
    const started = await checkout(person);
    const deliveries = payments.pay(started.checkoutRef);
    await deliverAll(deliveries);
    for (const delivery of deliveries) {
      const again = await deliver(delivery);
      expect(again.json()).toEqual({ received: true, duplicate: true });
    }
    const invoices = await env.db
      .selectFrom('billing_invoices')
      .select('id')
      .where('user_id', '=', person.id)
      .execute();
    expect(invoices).toHaveLength(1);
  });

  it('concurrent deliveries of the same event apply once', async () => {
    const person = await customer(GERMANY);
    const started = await checkout(person);
    const [completed, created, paid] = payments.pay(started.checkoutRef);
    await deliverAll([completed!, created!]);
    const counter = async () =>
      Number(
        (
          await env.db
            .selectFrom('billing_invoice_counters')
            .select((eb) => eb.fn.sum<string>('last_number').as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
    const before = await counter();
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(paid!)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json<{ duplicate: boolean }>().duplicate)).toHaveLength(5);
    const invoices = await env.db
      .selectFrom('billing_invoices')
      .select('number')
      .where('user_id', '=', person.id)
      .execute();
    expect(invoices).toHaveLength(1);
    // Invoice numbers stay consecutive: no number was used up by the duplicates.
    expect(await counter()).toBe(before + 1);
  });

  it('out-of-order deliveries end in the provider’s current state', async () => {
    const person = await customer();
    const started = await checkout(person);
    const ref = started.checkoutRef;
    const [authenticated, activated, charged] = payments.pay(ref);
    // The charge arrives first, then the older lifecycle events.
    await deliverAll([charged!, activated!, authenticated!]);
    expect((await tier(person)).tier).toBe('premium');
    expect(
      (await person.client.get('/api/v1/billing/subscription')).json<{
        subscription: { status: string };
      }>().subscription.status,
    ).toBe('active');

    // It ends; a delayed "activated" retry afterwards does not bring it back.
    const ended = payments.end(ref);
    await deliverAll(ended);
    const stale = payments.razorpayDelivery(JSON.parse(activated!.body) as Record<string, unknown>);
    expect((await deliver(stale)).statusCode).toBe(200);
    expect((await tier(person)).tier).toBe('free');
    const row = await env.db
      .selectFrom('billing_subscriptions')
      .select(['status', 'ended_at'])
      .where('id', '=', started.subscriptionId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('canceled');
    expect(row.ended_at).not.toBeNull();
  });

  it('refuses forged, tampered, stale and unidentified deliveries', async () => {
    const person = await customer(GERMANY);
    const started = await checkout(person);
    const [, created] = payments.pay(started.checkoutRef);
    const event = JSON.parse(created!.body) as Record<string, unknown>;

    const forged = payments.stripeDelivery(event, { secret: 'whsec_somebody_else_entirely' });
    expect((await deliver(forged)).statusCode).toBe(400);
    const tampered = { ...created!, body: created!.body.replace('"active"', '"trialing"') };
    expect((await deliver(tampered)).statusCode).toBe(400);
    const stale = payments.stripeDelivery(event, {
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    expect((await deliver(stale)).statusCode).toBe(400);
    const unsigned = { ...created!, headers: { 'content-type': 'application/json' } };
    expect((await deliver(unsigned)).statusCode).toBe(400);
    // Razorpay deliveries need their event id (it is what makes retries idempotent).
    const razorpay = payments.razorpayDelivery({ event: 'subscription.activated', payload: {} });
    const { ['x-razorpay-event-id']: _id, ...withoutId } = razorpay.headers;
    expect((await deliver({ ...razorpay, headers: withoutId })).statusCode).toBe(400);
    // A Razorpay delivery signed with someone else's secret (with a valid event id).
    const india = await customer();
    const paid = await checkout(india);
    const [, activated] = payments.pay(paid.checkoutRef);
    const forgedRazorpay = payments.razorpayDelivery(
      JSON.parse(activated!.body) as Record<string, unknown>,
      { secret: 'razorpay_webhook_of_somebody_else' },
    );
    expect((await deliver(forgedRazorpay)).statusCode).toBe(400);
    expect((await tier(india)).tier).toBe('free');
    // Delivered to the wrong provider's endpoint.
    expect((await deliver({ ...created!, provider: 'razorpay' })).statusCode).toBe(400);

    expect((await tier(person)).tier).toBe('free');
    const events = await env.db
      .selectFrom('billing_events')
      .select('event_id')
      .where('event_id', '=', String(event['id']))
      .execute();
    expect(events).toHaveLength(0);
  });

  it('acknowledges events for subscriptions that are not Tessera’s', async () => {
    const foreign = payments.stripeDelivery({
      id: 'evt_foreign_1',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_not_ours', metadata: {} } },
    });
    const response = await deliver(foreign);
    // The stand-in does not know it either: fetching it fails, so the provider retries later.
    expect([200, 503]).toContain(response.statusCode);
    const ignored = payments.stripeDelivery({
      id: 'evt_irrelevant_1',
      type: 'customer.created',
      data: { object: { id: 'cus_1' } },
    });
    expect((await deliver(ignored)).json()).toEqual({ received: true, duplicate: false });
    expect((await deliver(ignored)).json()).toEqual({ received: true, duplicate: true });
  });
});

describe("cancellation, renewal, grace and refunds ('billing.cancel', 'billing.resume')", () => {
  it('cancelling keeps the plan to the end of the period; Stripe can undo it', async () => {
    const person = await customer(GERMANY);
    const ref = await subscribe(person);
    const cancelled = await person.client.post('/api/v1/billing/subscription/cancel', {});
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      subscription: { cancelAtPeriodEnd: true, status: 'active', canResume: true },
    });
    expect(payments.subscription(ref)?.cancelAtPeriodEnd).toBe(true);
    expect((await tier(person)).tier).toBe('premium');
    const resumed = await person.client.post('/api/v1/billing/subscription/resume', {});
    expect(resumed.json()).toMatchObject({ subscription: { cancelAtPeriodEnd: false } });
    expect(payments.subscription(ref)?.cancelAtPeriodEnd).toBe(false);

    await person.client.post('/api/v1/billing/subscription/cancel', {});
    await deliverAll(payments.end(ref));
    expect((await tier(person)).tier).toBe('free');
    expect((await uploadOf(person, 300 * MIB)).statusCode).toBe(413);
    expect(
      (await person.client.get('/api/v1/billing/subscription')).json<{ subscription: null }>()
        .subscription,
    ).toBeNull();
  });

  it('Razorpay cancellations cannot be undone (said plainly)', async () => {
    const person = await customer();
    await subscribe(person);
    const cancelled = await person.client.post('/api/v1/billing/subscription/cancel', {});
    expect(cancelled.json()).toMatchObject({ subscription: { canResume: false } });
    const resume = await person.client.post('/api/v1/billing/subscription/resume', {});
    expect(resume.statusCode).toBe(409);
  });

  it('renewals add an invoice; a failed renewal keeps the plan for 7 days', async () => {
    const person = await customer();
    const ref = await subscribe(person);
    await deliverAll(payments.renew(ref));
    const numbers = (await person.client.get('/api/v1/billing/invoices'))
      .json<{ invoices: { number: string }[] }>()
      .invoices.map((invoice) => invoice.number);
    expect(numbers).toHaveLength(2);

    await deliverAll(payments.failRenewal(ref));
    const grace = await tier(person);
    expect(grace.tier).toBe('premium');
    const until = new Date(grace.validUntil ?? 0).getTime();
    expect(until).toBeGreaterThan(Date.now() + 6.9 * DAY);
    expect(until).toBeLessThan(Date.now() + 7.1 * DAY);
    expect(
      (await person.client.get('/api/v1/billing/subscription')).json<{
        subscription: { status: string };
      }>().subscription.status,
    ).toBe('past_due');

    // The grace period runs from the first failure, not from each retry's webhook.
    await env.db
      .updateTable('billing_subscriptions')
      .set({ past_due_since: new Date(Date.now() - 8 * DAY) })
      .where('provider_ref', '=', ref)
      .execute();
    await deliverAll(payments.failRenewal(ref));
    expect((await tier(person)).tier).toBe('free');
  });

  it('refunds are recorded on the invoice, never lowered by a late event', async () => {
    const person = await customer();
    await subscribe(person);
    const invoice = await env.db
      .selectFrom('billing_invoices')
      .select(['id', 'payment_ref', 'provider'])
      .where('user_id', '=', person.id)
      .executeTakeFirstOrThrow();
    const partial = payments.refund('razorpay', invoice.payment_ref, 4000);
    const full = payments.refund('razorpay', invoice.payment_ref, 9900);
    await deliverAll(full);
    await deliverAll(partial); // older event, arriving late
    await deliverAll(full); // duplicate
    const view = (await person.client.get(`/api/v1/billing/invoices/${invoice.id}`)).json<{
      refundedMinor: number;
    }>();
    expect(view.refundedMinor).toBe(9900);
  });

  it('a second paid checkout (two tabs) is ended at once; one plan stays', async () => {
    const person = await customer(GERMANY);
    const first = await checkout(person);
    const second = await checkout(person);
    await deliverAll(payments.pay(first.checkoutRef));
    await deliverAll(payments.pay(second.checkoutRef));
    const rows = await env.db
      .selectFrom('billing_subscriptions')
      .select(['id', 'status', 'provider_status'])
      .where('user_id', '=', person.id)
      .execute();
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
    // Marked a duplicate, then ended at the provider (whose state the next event reports).
    expect(rows.find((r) => r.id === second.subscriptionId)?.status).toBe('canceled');
    const secondRef = payments.stripeSubscriptionOf(second.checkoutRef) ?? '';
    expect(payments.subscription(secondRef)?.status).toBe('canceled');
    expect(
      env.logs
        .records()
        .some((r) => r['event'] === 'billing.alert' && r['check'] === 'duplicate_subscription'),
    ).toBe(true);
    expect((await tier(person)).tier).toBe('premium');
  });

  it('every status change is audited without payment details', async () => {
    const person = await customer();
    const started = await checkout(person);
    await deliverAll(payments.pay(started.checkoutRef));
    const entries = await env.db
      .selectFrom('audit_log')
      .select(['action', 'actor_kind', 'details'])
      .where('target_id', '=', started.subscriptionId)
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => e.action)).toEqual([
      'billing.checkout_started',
      'billing.status_changed',
    ]);
    expect(entries[1]).toMatchObject({
      actor_kind: 'system',
      details: { from: 'incomplete', to: 'active', provider: 'razorpay' },
    });
    expect(JSON.stringify(entries)).not.toMatch(/pay_|sk_test|secret/);
  });
});
