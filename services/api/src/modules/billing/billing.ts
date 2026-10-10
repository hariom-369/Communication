import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  INDIAN_STATES,
  type BillingProfile,
  type Currency,
  type Invoice,
  type Plan,
  type Provider,
  type Subscription,
  type SubscriptionStatus,
  type Tier,
} from '@tessera/validation';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

import type {
  BillingInvoicesTable,
  BillingPlansTable,
  BillingSubscriptionsTable,
  Database,
} from '../../db/schema.js';

import type { PaymentProvider, ProviderEvent, ProviderSubscription } from './providers.js';
import { financialYear, invoiceNumber, taxFor } from './tax.js';

/**
 * Billing (docs/billing.md, ADR-024, ADR-051): plans, a billing profile, hosted checkout,
 * cancellation, provider webhooks and GST invoices. Entitlements are told about every change in
 * the same transaction; messaging, media and channels only ever ask entitlements.
 *
 * Webhooks: each event is applied once (`billing_events` primary key, inserted in the same
 * transaction as its effect); concurrent events for one subscription are serialised by an
 * advisory lock, and the state applied is always the provider's current state, fetched inside
 * that lock — so duplicates, retries and out-of-order deliveries all end in the same state.
 */

type SubscriptionRow = Selectable<BillingSubscriptionsTable>;
type PlanRow = Selectable<BillingPlansTable>;
type InvoiceRow = Selectable<BillingInvoicesTable>;

const DAY_MS = 86_400_000;
/** A renewal webhook may arrive a little after the period ends. */
const RENEWAL_LEEWAY_MS = DAY_MS;
/** docs/billing.md §3: a failed renewal keeps the plan for 7 days while the provider retries. */
export const GRACE_MS = 7 * DAY_MS;

export interface BillingAuditPort {
  record(
    entry: {
      actorKind: 'user' | 'system';
      actorId: string | null;
      action: string;
      targetKind?: string;
      targetId?: string;
      details?: Record<string, string | number | boolean | null>;
    },
    executor?: Transaction<Database>,
  ): Promise<void>;
}

export interface EntitlementsPort {
  setTier(
    executor: Transaction<Database>,
    userId: string,
    subscriptionId: string,
    grant: { tier: Exclude<Tier, 'free'>; validUntil: Date } | null,
  ): Promise<void>;
  invalidate(userId: string): Promise<void>;
}

export interface Seller {
  readonly name: string;
  readonly address: string;
  readonly gstin: string | null;
  /** ISO 3166-2:IN state code of the seller's registration. */
  readonly state: string;
  readonly sacCode: string;
}

export interface BillingDeps {
  readonly db: Kysely<Database>;
  readonly providers: readonly PaymentProvider[];
  readonly entitlements: EntitlementsPort;
  readonly audit: BillingAuditPort;
  readonly seller: Seller | null;
  /** Where the hosted checkout returns to. */
  readonly returnUrl: string;
  /** The `billing` kill switch (new checkouts only). */
  readonly checkoutEnabled: () => Promise<boolean>;
  readonly logger: Logger;
}

/**
 * Until when a subscription in this state entitles to its tier (docs/billing.md §3): an active
 * one to the end of its period (plus a day for a late renewal webhook); a past-due one for 7 days
 * from the first failed renewal; anything else not at all.
 */
export function grantFor(
  status: SubscriptionStatus,
  periodEnd: Date | null,
  pastDueSince: Date | null,
  now = new Date(),
): Date | null {
  if (status === 'active')
    return new Date((periodEnd?.getTime() ?? now.getTime()) + RENEWAL_LEEWAY_MS);
  if (status === 'past_due') {
    const until = new Date((pastDueSince ?? now).getTime() + GRACE_MS);
    return until.getTime() > now.getTime() ? until : null;
  }
  return null;
}

export class BillingService {
  readonly #d: BillingDeps;
  readonly #providers: Map<Provider, PaymentProvider>;

  constructor(deps: BillingDeps) {
    this.#d = deps;
    this.#providers = new Map(deps.providers.map((provider) => [provider.name, provider]));
  }

  #provider(name: Provider): PaymentProvider {
    const provider = this.#providers.get(name);
    if (provider === undefined)
      throw new AppError('SERVICE_UNAVAILABLE', { detail: 'This payment provider is not set up.' });
    return provider;
  }

  /** India pays in rupees through Razorpay; everyone else in dollars through Stripe. */
  static providerFor(country: string): { provider: Provider; currency: Currency } {
    return country === 'IN'
      ? { provider: 'razorpay', currency: 'INR' }
      : { provider: 'stripe', currency: 'USD' };
  }

  // ---- plans and profile ------------------------------------------------------------------------

  async plans(userId: string): Promise<{
    plans: Plan[];
    currency: Currency | null;
    provider: Provider | null;
  }> {
    const [rows, profile, open] = await Promise.all([
      this.#d.db
        .selectFrom('billing_plans')
        .selectAll()
        .where('active', '=', true)
        .orderBy('sort_order')
        .execute(),
      this.profile(userId),
      this.#d.checkoutEnabled(),
    ]);
    const route = profile === null ? null : BillingService.providerFor(profile.country);
    const provider = route === null ? undefined : this.#providers.get(route.provider);
    const currency = route?.currency ?? 'INR';
    return {
      plans: rows.map((row) => ({
        code: row.code,
        tier: row.tier,
        name: row.name,
        interval: row.interval,
        price: {
          currency,
          amountMinor: currency === 'INR' ? row.price_inr_minor : row.price_usd_minor,
        },
        available: open && this.#d.seller !== null && provider?.priceRef(row.code) !== undefined,
      })),
      currency: route?.currency ?? null,
      provider: route?.provider ?? null,
    };
  }

  async profile(userId: string): Promise<BillingProfile | null> {
    const row = await this.#d.db
      .selectFrom('billing_profiles')
      .select(['legal_name', 'country', 'state', 'gstin'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          legalName: row.legal_name,
          country: row.country,
          state: row.state as BillingProfile['state'],
          gstin: row.gstin,
        };
  }

  async setProfile(userId: string, profile: BillingProfile): Promise<BillingProfile> {
    const live = await this.#live(userId);
    const current = await this.profile(userId);
    // The currency (and provider) follows the country; it cannot change under a running plan.
    if (
      live !== undefined &&
      current !== null &&
      BillingService.providerFor(current.country).provider !==
        BillingService.providerFor(profile.country).provider
    )
      throw new AppError('CONFLICT', {
        detail: 'You can move your billing country when your current plan ends.',
      });
    const values = {
      legal_name: profile.legalName,
      country: profile.country,
      state: profile.state,
      gstin: profile.gstin,
    };
    await this.#d.db
      .insertInto('billing_profiles')
      .values({ user_id: userId, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet({ ...values, updated_at: new Date() }))
      .execute();
    return profile;
  }

  // ---- subscriptions --------------------------------------------------------------------------------

  async #live(userId: string): Promise<SubscriptionRow | undefined> {
    return this.#d.db
      .selectFrom('billing_subscriptions')
      .selectAll()
      .where('user_id', '=', userId)
      .where('status', 'in', ['active', 'past_due'])
      .executeTakeFirst();
  }

  async #plan(code: string): Promise<PlanRow> {
    const plan = await this.#d.db
      .selectFrom('billing_plans')
      .selectAll()
      .where('code', '=', code)
      .executeTakeFirst();
    if (plan === undefined) throw new AppError('NOT_FOUND', { detail: 'No such plan.' });
    return plan;
  }

  #view(row: SubscriptionRow, plan: PlanRow): Subscription {
    return {
      id: row.id,
      planCode: row.plan_code,
      planName: plan.name,
      tier: plan.tier,
      provider: row.provider,
      status: row.status,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
      canResume: row.cancel_at_period_end && this.#providers.get(row.provider)?.canResume === true,
    };
  }

  /** The plan in force, else the latest checkout still waiting for payment. */
  async subscription(userId: string): Promise<Subscription | null> {
    const row =
      (await this.#live(userId)) ??
      (await this.#d.db
        .selectFrom('billing_subscriptions')
        .selectAll()
        .where('user_id', '=', userId)
        .where('status', '=', 'incomplete')
        .where('created_at', '>', new Date(Date.now() - DAY_MS))
        .orderBy('created_at', 'desc')
        .executeTakeFirst());
    if (row === undefined) return null;
    return this.#view(row, await this.#plan(row.plan_code));
  }

  async checkout(
    userId: string,
    planCode: string,
  ): Promise<{ url: string; subscriptionId: string }> {
    if (!(await this.#d.checkoutEnabled()))
      throw new AppError('SERVICE_UNAVAILABLE', { detail: 'New subscriptions are paused.' });
    if (this.#d.seller === null)
      throw new AppError('SERVICE_UNAVAILABLE', { detail: 'Subscriptions are not set up.' });
    const profile = await this.profile(userId);
    if (profile === null)
      throw new AppError('CONFLICT', { detail: 'Add your billing details first.' });
    if ((await this.#live(userId)) !== undefined)
      throw new AppError('CONFLICT', { detail: 'You already have a plan.' });
    const plan = await this.#plan(planCode);
    if (!plan.active) throw new AppError('NOT_FOUND', { detail: 'No such plan.' });
    const provider = this.#provider(BillingService.providerFor(profile.country).provider);
    const priceRef = provider.priceRef(plan.code);
    if (priceRef === undefined)
      throw new AppError('CONFLICT', { detail: 'This plan cannot be bought here yet.' });
    const id = newId();
    const started = await provider.checkout({
      tesseraId: id,
      userId,
      priceRef,
      interval: plan.interval,
      returnUrl: this.#d.returnUrl,
    });
    await this.#d.db
      .insertInto('billing_subscriptions')
      .values({
        id,
        user_id: userId,
        plan_code: plan.code,
        provider: provider.name,
        provider_ref: started.providerRef,
        checkout_ref: started.checkoutRef,
        status: 'incomplete',
        provider_status: 'checkout',
      })
      .execute();
    await this.#d.audit.record({
      actorKind: 'user',
      actorId: userId,
      action: 'billing.checkout_started',
      targetKind: 'billing_subscription',
      targetId: id,
      details: { plan: plan.code, provider: provider.name },
    });
    return { url: started.url, subscriptionId: id };
  }

  /** Easy cancellation: the plan stays until the end of the paid period, then ends. */
  async cancel(userId: string): Promise<Subscription> {
    const row = await this.#live(userId);
    const ref = row?.provider_ref ?? null;
    if (row === undefined || ref === null)
      throw new AppError('NOT_FOUND', { detail: 'You have no plan to cancel.' });
    if (!row.cancel_at_period_end) {
      await this.#provider(row.provider).cancelAtPeriodEnd(ref);
      await this.#d.db
        .updateTable('billing_subscriptions')
        .set({ cancel_at_period_end: true, updated_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await this.#d.audit.record({
        actorKind: 'user',
        actorId: userId,
        action: 'billing.cancelled',
        targetKind: 'billing_subscription',
        targetId: row.id,
      });
    }
    return this.#view({ ...row, cancel_at_period_end: true }, await this.#plan(row.plan_code));
  }

  async resume(userId: string): Promise<Subscription> {
    const row = await this.#live(userId);
    const ref = row?.provider_ref ?? null;
    if (row === undefined || ref === null || !row.cancel_at_period_end)
      throw new AppError('NOT_FOUND', { detail: 'There is no cancellation to undo.' });
    await this.#provider(row.provider).resume(ref);
    await this.#d.db
      .updateTable('billing_subscriptions')
      .set({ cancel_at_period_end: false, updated_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    await this.#d.audit.record({
      actorKind: 'user',
      actorId: userId,
      action: 'billing.resumed',
      targetKind: 'billing_subscription',
      targetId: row.id,
    });
    return this.#view({ ...row, cancel_at_period_end: false }, await this.#plan(row.plan_code));
  }

  // ---- invoices ---------------------------------------------------------------------------------

  #invoiceView(row: InvoiceRow): Invoice {
    return {
      id: row.id,
      number: row.number,
      issuedAt: row.issued_at.toISOString(),
      planName: row.plan_name,
      periodStart: row.period_start?.toISOString() ?? null,
      periodEnd: row.period_end?.toISOString() ?? null,
      currency: row.currency,
      totalMinor: row.total_minor,
      taxableMinor: row.taxable_minor,
      cgstMinor: row.cgst_minor,
      sgstMinor: row.sgst_minor,
      igstMinor: row.igst_minor,
      taxNote: row.tax_note,
      refundedMinor: row.refunded_minor,
      sacCode: row.sac_code,
      buyer: {
        name: row.buyer_name,
        country: row.buyer_country,
        state: row.buyer_state,
        gstin: row.buyer_gstin,
      },
      seller: {
        name: row.seller_name,
        address: row.seller_address,
        gstin: row.seller_gstin,
        state: row.seller_state,
      },
    };
  }

  async invoices(userId: string): Promise<Invoice[]> {
    const rows = await this.#d.db
      .selectFrom('billing_invoices')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('issued_at', 'desc')
      .limit(200)
      .execute();
    return rows.map((row) => this.#invoiceView(row));
  }

  async invoice(userId: string, invoiceId: string): Promise<Invoice> {
    const row = await this.#d.db
      .selectFrom('billing_invoices')
      .selectAll()
      .where('id', '=', invoiceId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    return this.#invoiceView(row);
  }

  // ---- webhooks ---------------------------------------------------------------------------------

  /** Verifies, deduplicates and applies one provider delivery. */
  async webhook(
    providerName: Provider,
    raw: Buffer,
    header: (name: string) => string | undefined,
  ): Promise<{ duplicate: boolean }> {
    const provider = this.#provider(providerName);
    let event: ProviderEvent;
    try {
      event = provider.parseWebhook(raw, header);
    } catch (error) {
      this.#d.logger.warn('billing.webhook_rejected', {
        component: 'billing',
        check: providerName,
      });
      throw error;
    }
    const seen = await this.#d.db
      .selectFrom('billing_events')
      .select('event_id')
      .where('provider', '=', providerName)
      .where('event_id', '=', event.eventId)
      .executeTakeFirst();
    if (seen !== undefined) return { duplicate: true };

    if (event.kind === 'ignored')
      return this.#record(providerName, event.eventId, event.type, null);
    if (event.kind === 'refund') return this.#refund(providerName, event);

    const row = await this.#find(provider, event.subscriptionRef, event.tesseraId);
    if (row === undefined) {
      // Not one of ours (another product on the same provider account): acknowledged, ignored.
      this.#d.logger.warn('billing.unknown_subscription', {
        component: 'billing',
        check: providerName,
      });
      return this.#record(providerName, event.eventId, event.type, null);
    }
    const after: (() => Promise<void>)[] = [];
    const duplicate = await this.#d.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`billing:${row.id}`}))`.execute(trx);
      const inserted = await trx
        .insertInto('billing_events')
        .values({
          provider: providerName,
          event_id: event.eventId,
          type: event.type,
          subscription_id: row.id,
        })
        .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (inserted === undefined) return true; // a concurrent delivery of the same event won
      // The provider's state now, read inside the lock: later events cannot be overtaken.
      const current = await provider.fetchSubscription(event.subscriptionRef);
      await this.#apply(trx, row.id, current, after);
      if (event.kind === 'payment')
        await this.#issueInvoice(trx, row.id, providerName, event.payment);
      return false;
    });
    for (const task of after) await task();
    await this.#d.entitlements.invalidate(row.user_id);
    return { duplicate };
  }

  async #record(
    provider: Provider,
    eventId: string,
    type: string,
    subscriptionId: string | null,
  ): Promise<{ duplicate: boolean }> {
    const inserted = await this.#d.db
      .insertInto('billing_events')
      .values({ provider, event_id: eventId, type, subscription_id: subscriptionId })
      .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
      .returning('event_id')
      .executeTakeFirst();
    return { duplicate: inserted === undefined };
  }

  async #find(
    provider: PaymentProvider,
    ref: string,
    tesseraId: string | null,
  ): Promise<SubscriptionRow | undefined> {
    const byRef = await this.#d.db
      .selectFrom('billing_subscriptions')
      .selectAll()
      .where('provider', '=', provider.name)
      .where('provider_ref', '=', ref)
      .executeTakeFirst();
    if (byRef !== undefined) return byRef;
    // First event for a Stripe subscription: our id is in the provider's metadata.
    const id = tesseraId ?? (await provider.fetchSubscription(ref)).tesseraId;
    if (id === null || !/^[0-9a-f-]{36}$/.test(id)) return undefined;
    return this.#d.db
      .selectFrom('billing_subscriptions')
      .selectAll()
      .where('id', '=', id)
      .where('provider', '=', provider.name)
      .executeTakeFirst();
  }

  async #apply(
    trx: Transaction<Database>,
    id: string,
    current: ProviderSubscription,
    after: (() => Promise<void>)[],
  ): Promise<void> {
    const row = await trx
      .selectFrom('billing_subscriptions')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    let status = current.status;
    let providerStatus = current.providerStatus;
    // Two checkouts paid (two tabs): keep the plan in force, end the other one at once.
    if (status === 'active' || status === 'past_due') {
      const other = await trx
        .selectFrom('billing_subscriptions')
        .select('id')
        .where('user_id', '=', row.user_id)
        .where('id', '<>', row.id)
        .where('status', 'in', ['active', 'past_due'])
        .executeTakeFirst();
      if (other !== undefined) {
        status = 'canceled';
        providerStatus = 'duplicate';
        const provider = this.#provider(row.provider);
        after.push(async () => {
          await provider.cancelNow(current.ref).catch((error: unknown) => {
            this.#d.logger.error(
              'billing.duplicate_cancel_failed',
              this.#d.logger.errorFields(error),
            );
          });
        });
        // Support refunds the second payment (it shows in the provider dashboard).
        this.#d.logger.warn('billing.alert', {
          component: 'billing',
          check: 'duplicate_subscription',
        });
      }
    }
    const ended = status === 'canceled';
    const pastDueSince = status === 'past_due' ? (row.past_due_since ?? new Date()) : null;
    await trx
      .updateTable('billing_subscriptions')
      .set({
        provider_ref: current.ref,
        status,
        provider_status: providerStatus,
        cancel_at_period_end: current.cancelAtPeriodEnd ?? row.cancel_at_period_end,
        current_period_start: current.periodStart ?? row.current_period_start,
        current_period_end: current.periodEnd ?? row.current_period_end,
        updated_at: new Date(),
        ended_at: ended ? (row.ended_at ?? new Date()) : null,
        past_due_since: pastDueSince,
      })
      .where('id', '=', row.id)
      .execute();
    const plan = await trx
      .selectFrom('billing_plans')
      .select('tier')
      .where('code', '=', row.plan_code)
      .executeTakeFirstOrThrow();
    const validUntil = grantFor(status, current.periodEnd ?? row.current_period_end, pastDueSince);
    await this.#d.entitlements.setTier(
      trx,
      row.user_id,
      row.id,
      validUntil === null ? null : { tier: plan.tier, validUntil },
    );
    if (status !== row.status)
      await this.#d.audit.record(
        {
          actorKind: 'system',
          actorId: null,
          action: 'billing.status_changed',
          targetKind: 'billing_subscription',
          targetId: row.id,
          details: { from: row.status, to: status, provider: row.provider, plan: row.plan_code },
        },
        trx,
      );
  }

  async #issueInvoice(
    trx: Transaction<Database>,
    subscriptionId: string,
    provider: Provider,
    payment: Extract<ProviderEvent, { kind: 'payment' }>['payment'],
  ): Promise<void> {
    const seller = this.#d.seller;
    if (seller === null)
      throw new AppError('SERVICE_UNAVAILABLE', { detail: 'No seller details.' });
    const existing = await trx
      .selectFrom('billing_invoices')
      .select('id')
      .where('provider', '=', provider)
      .where('payment_ref', '=', payment.ref)
      .executeTakeFirst();
    if (existing !== undefined) return; // one tax invoice per payment
    const sub = await trx
      .selectFrom('billing_subscriptions')
      .innerJoin('billing_plans', 'billing_plans.code', 'billing_subscriptions.plan_code')
      .select(['billing_subscriptions.user_id', 'billing_plans.code', 'billing_plans.name'])
      .where('billing_subscriptions.id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    const buyer = await trx
      .selectFrom('billing_profiles')
      .select(['legal_name', 'country', 'state', 'gstin'])
      .where('user_id', '=', sub.user_id)
      .executeTakeFirst();
    const buyerCountry = buyer?.country ?? (payment.currency === 'INR' ? 'IN' : 'ZZ');
    const tax = taxFor({
      totalMinor: payment.amountMinor,
      currency: payment.currency,
      buyerCountry,
      buyerState: buyer?.state ?? null,
      sellerState: seller.state,
    });
    const issuedAt = new Date();
    const year = financialYear(issuedAt);
    const counter = await trx
      .insertInto('billing_invoice_counters')
      .values({ financial_year: year, last_number: 1 })
      .onConflict((oc) =>
        oc.column('financial_year').doUpdateSet({
          last_number: sql`billing_invoice_counters.last_number + 1`,
        }),
      )
      .returning('last_number')
      .executeTakeFirstOrThrow();
    const stateName = (code: string | null | undefined) =>
      code === null || code === undefined
        ? null
        : ((INDIAN_STATES as Record<string, { name: string } | undefined>)[code]?.name ?? code);
    await trx
      .insertInto('billing_invoices')
      .values({
        id: newId(),
        number: invoiceNumber(year, counter.last_number),
        user_id: sub.user_id,
        subscription_id: subscriptionId,
        provider,
        payment_ref: payment.ref,
        issued_at: issuedAt,
        plan_code: sub.code,
        plan_name: sub.name,
        period_start: payment.periodStart,
        period_end: payment.periodEnd,
        currency: payment.currency,
        total_minor: payment.amountMinor,
        taxable_minor: tax.taxableMinor,
        cgst_minor: tax.cgstMinor,
        sgst_minor: tax.sgstMinor,
        igst_minor: tax.igstMinor,
        tax_note: tax.note,
        sac_code: seller.sacCode,
        buyer_name: buyer?.legal_name ?? 'Customer',
        buyer_country: buyerCountry,
        buyer_state: stateName(buyer?.state),
        buyer_gstin: buyer?.gstin ?? null,
        seller_name: seller.name,
        seller_address: seller.address,
        seller_gstin: seller.gstin,
        seller_state: stateName(seller.state) ?? seller.state,
      })
      .execute();
  }

  async #refund(
    provider: Provider,
    event: Extract<ProviderEvent, { kind: 'refund' }>,
  ): Promise<{ duplicate: boolean }> {
    return this.#d.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('billing_events')
        .values({ provider, event_id: event.eventId, type: event.type, subscription_id: null })
        .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (inserted === undefined) return { duplicate: true };
      // Totals only grow, so out-of-order refund events cannot lower the recorded amount.
      await trx
        .updateTable('billing_invoices')
        .set({
          refunded_minor: sql`LEAST(total_minor, GREATEST(refunded_minor, ${event.refundedMinor}))`,
        })
        .where('provider', '=', provider)
        .where('payment_ref', '=', event.paymentRef)
        .execute();
      return { duplicate: false };
    });
  }
}
