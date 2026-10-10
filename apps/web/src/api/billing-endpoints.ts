import {
  billingProfileResponseSchema,
  checkoutResponseSchema,
  entitlementsSchema,
  invoiceListSchema,
  invoiceSchema,
  planListSchema,
  subscriptionResponseSchema,
  type billingProfileSchema,
} from '@tessera/validation';
import type { z } from 'zod';

import { api } from './client.js';

const enc = encodeURIComponent;

/** Plans, subscriptions and invoices (docs/billing.md); schemas are shared with the server. */
export const billingEndpoints = {
  entitlements: () => api('GET', '/entitlements', entitlementsSchema),
  plans: () => api('GET', '/billing/plans', planListSchema),
  profile: () => api('GET', '/billing/profile', billingProfileResponseSchema),
  saveProfile: (profile: z.input<typeof billingProfileSchema>) =>
    api('PUT', '/billing/profile', billingProfileResponseSchema, profile),
  subscription: () => api('GET', '/billing/subscription', subscriptionResponseSchema),
  checkout: (planCode: string) =>
    api('POST', '/billing/checkout', checkoutResponseSchema, { planCode }),
  cancel: () => api('POST', '/billing/subscription/cancel', subscriptionResponseSchema, {}),
  resume: () => api('POST', '/billing/subscription/resume', subscriptionResponseSchema, {}),
  invoices: () => api('GET', '/billing/invoices', invoiceListSchema),
  invoice: (invoiceId: string) => api('GET', `/billing/invoices/${enc(invoiceId)}`, invoiceSchema),
};
