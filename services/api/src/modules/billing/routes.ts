import {
  billingProfileResponseSchema,
  billingProfileSchema,
  checkoutRequestSchema,
  checkoutResponseSchema,
  invoiceListSchema,
  invoiceParamsSchema,
  invoiceSchema,
  planListSchema,
  subscriptionResponseSchema,
  type Provider,
} from '@tessera/validation';
import { z } from 'zod';

import {
  defineRoute,
  ownAccount,
  publicAccess,
  type RouteDefinition,
} from '../../platform/http/routes.js';
import type { RateLimitPolicy } from '../../platform/rate-limit.js';

import type { BillingService } from './billing.js';

export interface BillingModuleDeps {
  readonly billing: BillingService;
}

const policy = (
  name: string,
  limit: number,
  periodMs: number,
  burst: number,
  onStoreFailure: 'open' | 'closed' = 'open',
): RateLimitPolicy => ({ name: `billing.${name}`, limit, periodMs, burst, onStoreFailure });
const limits = {
  read: policy('read', 120, 60_000, 30),
  write: policy('write', 30, 3_600_000, 10),
  checkout: policy('checkout', 10, 3_600_000, 5, 'closed'),
  // Per provider address; providers retry, so this is generous.
  webhook: policy('webhook', 600, 60_000, 200),
};

function webhookRoute(provider: Provider, billing: BillingService): RouteDefinition {
  return defineRoute({
    id: `billing.webhook_${provider}`,
    method: 'POST',
    url: `/api/v1/billing/webhooks/${provider}`,
    summary: `Payment events from ${provider === 'stripe' ? 'Stripe' : 'Razorpay'} (signed)`,
    tags: ['billing'],
    auth: { kind: 'webhook' },
    authorize: publicAccess,
    rateLimit: limits.webhook,
    audit: { kind: 'records', actions: ['billing.status_changed'] },
    bodyLimit: 512 * 1024,
    schema: {
      response: z.object({ received: z.literal(true), duplicate: z.boolean() }),
    },
    successStatus: 200,
    handler: async (_request, context) => {
      const raw = context.rawBody ?? Buffer.alloc(0);
      const result = await billing.webhook(provider, raw, (name) => context.header(name));
      return { received: true as const, duplicate: result.duplicate };
    },
  });
}

export function billingRoutes(deps: BillingModuleDeps): RouteDefinition[] {
  const { billing } = deps;
  const session = { kind: 'session' } as const;
  return [
    defineRoute({
      id: 'billing.plans',
      method: 'GET',
      url: '/api/v1/billing/plans',
      summary: 'Plans and prices (in your currency)',
      tags: ['billing'],
      auth: session,
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: planListSchema },
      successStatus: 200,
      handler: (_request, context) => billing.plans(context.session.userId),
    }),
    defineRoute({
      id: 'billing.profile',
      method: 'GET',
      url: '/api/v1/billing/profile',
      summary: 'Your billing details (name and place for invoices)',
      tags: ['billing'],
      auth: session,
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: billingProfileResponseSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        profile: await billing.profile(context.session.userId),
      }),
    }),
    defineRoute({
      id: 'billing.profile_update',
      method: 'PUT',
      url: '/api/v1/billing/profile',
      summary: 'Set your billing details',
      tags: ['billing'],
      auth: session,
      authorize: ownAccount,
      rateLimit: limits.write,
      audit: {
        kind: 'none',
        reason: 'The person’s own invoice details; snapshotted on each invoice',
      },
      schema: { body: billingProfileSchema, response: billingProfileResponseSchema },
      successStatus: 200,
      handler: async ({ body }, context) => ({
        profile: await billing.setProfile(context.session.userId, body),
      }),
    }),
    defineRoute({
      id: 'billing.subscription',
      method: 'GET',
      url: '/api/v1/billing/subscription',
      summary: 'Your plan (or a checkout waiting for payment)',
      tags: ['billing'],
      auth: session,
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: subscriptionResponseSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        subscription: await billing.subscription(context.session.userId),
      }),
    }),
    defineRoute({
      id: 'billing.checkout',
      method: 'POST',
      url: '/api/v1/billing/checkout',
      summary: 'Start paying for a plan on the provider’s page',
      tags: ['billing'],
      auth: session,
      authorize: ownAccount,
      rateLimit: limits.checkout,
      audit: { kind: 'records', actions: ['billing.checkout_started'] },
      schema: { body: checkoutRequestSchema, response: checkoutResponseSchema },
      successStatus: 201,
      handler: ({ body }, context) => billing.checkout(context.session.userId, body.planCode),
    }),
    defineRoute({
      id: 'billing.cancel',
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      summary: 'Cancel: the plan ends when the paid period does',
      tags: ['billing'],
      auth: session,
      authorize: ownAccount,
      rateLimit: limits.write,
      audit: { kind: 'records', actions: ['billing.cancelled'] },
      schema: { body: z.strictObject({}), response: subscriptionResponseSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        subscription: await billing.cancel(context.session.userId),
      }),
    }),
    defineRoute({
      id: 'billing.resume',
      method: 'POST',
      url: '/api/v1/billing/subscription/resume',
      summary: 'Undo a cancellation before the period ends (where the provider allows it)',
      tags: ['billing'],
      auth: session,
      authorize: ownAccount,
      rateLimit: limits.write,
      audit: { kind: 'records', actions: ['billing.resumed'] },
      schema: { body: z.strictObject({}), response: subscriptionResponseSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        subscription: await billing.resume(context.session.userId),
      }),
    }),
    defineRoute({
      id: 'billing.invoices',
      method: 'GET',
      url: '/api/v1/billing/invoices',
      summary: 'Your tax invoices',
      tags: ['billing'],
      auth: session,
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { response: invoiceListSchema },
      successStatus: 200,
      handler: async (_request, context) => ({
        invoices: await billing.invoices(context.session.userId),
      }),
    }),
    defineRoute({
      id: 'billing.invoice',
      method: 'GET',
      url: '/api/v1/billing/invoices/:invoiceId',
      summary: 'One tax invoice',
      tags: ['billing'],
      auth: session,
      authorize: ownAccount,
      rateLimit: limits.read,
      audit: { kind: 'none', reason: 'Read-only' },
      schema: { params: invoiceParamsSchema, response: invoiceSchema },
      successStatus: 200,
      handler: ({ params }, context) => billing.invoice(context.session.userId, params.invoiceId),
    }),
    webhookRoute('stripe', billing),
    webhookRoute('razorpay', billing),
  ];
}
