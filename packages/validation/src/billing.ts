import { z } from 'zod';

import { idSchema } from './common.js';

/**
 * Plans, subscriptions, entitlements and invoices (docs/billing.md, ADR-024, ADR-051). Card and
 * UPI details never reach Tessera: people pay on the provider's hosted page (Razorpay in India,
 * Stripe elsewhere). Security and privacy features are never paid features.
 */

export const TIERS = ['free', 'premium', 'creator', 'business'] as const;
export type Tier = (typeof TIERS)[number];

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * What each tier allows. Only limits the server enforces are listed; the free tier is exactly
 * what every account had before billing existed.
 */
export const TIER_LIMITS = {
  free: {
    'media.max_file_bytes': 200 * MIB,
    'media.daily_bytes': 2 * GIB,
    'media.daily_uploads': 300,
    'channels.max_owned': 20,
    'channels.schedule_days': 90,
  },
  premium: {
    'media.max_file_bytes': GIB,
    'media.daily_bytes': 20 * GIB,
    'media.daily_uploads': 1000,
    'channels.max_owned': 20,
    'channels.schedule_days': 90,
  },
  creator: {
    'media.max_file_bytes': GIB,
    'media.daily_bytes': 20 * GIB,
    'media.daily_uploads': 1000,
    'channels.max_owned': 100,
    'channels.schedule_days': 365,
  },
  business: {
    'media.max_file_bytes': GIB,
    'media.daily_bytes': 50 * GIB,
    'media.daily_uploads': 3000,
    'channels.max_owned': 100,
    'channels.schedule_days': 365,
  },
} as const satisfies Record<Tier, Record<string, number>>;
export type Entitlement = keyof (typeof TIER_LIMITS)['free'];
export type EntitlementLimits = Record<Entitlement, number>;

export const entitlementsSchema = z.object({
  tier: z.enum(TIERS),
  /** Until when a paid tier lasts (null on the free tier). */
  validUntil: z.string().nullable(),
  limits: z.object({
    'media.max_file_bytes': z.number().int(),
    'media.daily_bytes': z.number().int(),
    'media.daily_uploads': z.number().int(),
    'channels.max_owned': z.number().int(),
    'channels.schedule_days': z.number().int(),
  }),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

// ---- plans ------------------------------------------------------------------------------------

export const CURRENCIES = ['INR', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const PROVIDERS = ['razorpay', 'stripe'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const planSchema = z.object({
  code: z.string(),
  tier: z.enum(['premium', 'creator', 'business']),
  name: z.string(),
  interval: z.enum(['month', 'year']),
  /** In the smallest unit (paise, cents). INR prices include GST. */
  price: z.object({ currency: z.enum(CURRENCIES), amountMinor: z.number().int() }),
  /** Whether it can be bought right now (the provider is configured for it). */
  available: z.boolean(),
});
export const planListSchema = z.object({
  plans: z.array(planSchema),
  /** The currency and provider that apply to this person (from their billing country). */
  currency: z.enum(CURRENCIES).nullable(),
  provider: z.enum(PROVIDERS).nullable(),
});
export type Plan = z.infer<typeof planSchema>;

// ---- billing profile ------------------------------------------------------------------------------

/**
 * Indian states and union territories: ISO 3166-2:IN code → GST state code (place of supply,
 * first two digits of a GSTIN).
 */
export const INDIAN_STATES = {
  AN: { name: 'Andaman and Nicobar Islands', gst: '35' },
  AP: { name: 'Andhra Pradesh', gst: '37' },
  AR: { name: 'Arunachal Pradesh', gst: '12' },
  AS: { name: 'Assam', gst: '18' },
  BR: { name: 'Bihar', gst: '10' },
  CH: { name: 'Chandigarh', gst: '04' },
  CG: { name: 'Chhattisgarh', gst: '22' },
  DH: { name: 'Dadra and Nagar Haveli and Daman and Diu', gst: '26' },
  DL: { name: 'Delhi', gst: '07' },
  GA: { name: 'Goa', gst: '30' },
  GJ: { name: 'Gujarat', gst: '24' },
  HR: { name: 'Haryana', gst: '06' },
  HP: { name: 'Himachal Pradesh', gst: '02' },
  JK: { name: 'Jammu and Kashmir', gst: '01' },
  JH: { name: 'Jharkhand', gst: '20' },
  KA: { name: 'Karnataka', gst: '29' },
  KL: { name: 'Kerala', gst: '32' },
  LA: { name: 'Ladakh', gst: '38' },
  LD: { name: 'Lakshadweep', gst: '31' },
  MP: { name: 'Madhya Pradesh', gst: '23' },
  MH: { name: 'Maharashtra', gst: '27' },
  MN: { name: 'Manipur', gst: '14' },
  ML: { name: 'Meghalaya', gst: '17' },
  MZ: { name: 'Mizoram', gst: '15' },
  NL: { name: 'Nagaland', gst: '13' },
  OD: { name: 'Odisha', gst: '21' },
  PY: { name: 'Puducherry', gst: '34' },
  PB: { name: 'Punjab', gst: '03' },
  RJ: { name: 'Rajasthan', gst: '08' },
  SK: { name: 'Sikkim', gst: '11' },
  TN: { name: 'Tamil Nadu', gst: '33' },
  TS: { name: 'Telangana', gst: '36' },
  TR: { name: 'Tripura', gst: '16' },
  UP: { name: 'Uttar Pradesh', gst: '09' },
  UK: { name: 'Uttarakhand', gst: '05' },
  WB: { name: 'West Bengal', gst: '19' },
} as const;
export type IndianState = keyof typeof INDIAN_STATES;
const STATE_CODES = Object.keys(INDIAN_STATES) as [IndianState, ...IndianState[]];

/** GSTIN format (15 characters: state code, PAN, entity number, Z, check character). */
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const billingProfileSchema = z
  .strictObject({
    /** Name on invoices (a person or a business). */
    legalName: z.string().trim().min(1).max(200),
    /** ISO 3166-1 alpha-2. */
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, { message: 'Choose a country.' }),
    /** Required in India (place of supply for GST). */
    state: z.enum(STATE_CODES).nullable(),
    /** Optional, India only: a registered business gets a GST invoice in its name. */
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(GSTIN_PATTERN, { message: 'That is not a valid GSTIN.' })
      .nullable(),
  })
  .superRefine((profile, ctx) => {
    if (profile.country === 'IN' && profile.state === null)
      ctx.addIssue({ code: 'custom', path: ['state'], message: 'Choose your state.' });
    if (profile.country !== 'IN' && (profile.state !== null || profile.gstin !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'State and GSTIN apply only in India.',
      });
    if (
      profile.gstin !== null &&
      profile.state !== null &&
      profile.gstin.slice(0, 2) !== INDIAN_STATES[profile.state].gst
    )
      ctx.addIssue({
        code: 'custom',
        path: ['gstin'],
        message: 'The GSTIN is registered in a different state.',
      });
  });
export type BillingProfile = z.infer<typeof billingProfileSchema>;
export const billingProfileResponseSchema = z.object({ profile: billingProfileSchema.nullable() });

// ---- subscriptions ---------------------------------------------------------------------------

export const SUBSCRIPTION_STATUSES = ['incomplete', 'active', 'past_due', 'canceled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const subscriptionSchema = z.object({
  id: z.string(),
  planCode: z.string(),
  planName: z.string(),
  tier: z.enum(['premium', 'creator', 'business']),
  provider: z.enum(PROVIDERS),
  status: z.enum(SUBSCRIPTION_STATUSES),
  /** Renews at `currentPeriodEnd` unless this is set. */
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodEnd: z.string().nullable(),
  /** Whether the person can undo a scheduled cancellation (the provider must support it). */
  canResume: z.boolean(),
});
export const subscriptionResponseSchema = z.object({
  subscription: subscriptionSchema.nullable(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const checkoutRequestSchema = z.strictObject({ planCode: z.string().min(1).max(64) });
export const checkoutResponseSchema = z.object({
  /** The provider's hosted payment page. */
  url: z.string(),
  subscriptionId: z.string(),
});

// ---- invoices ---------------------------------------------------------------------------------

export const invoiceSchema = z.object({
  id: z.string(),
  number: z.string(),
  issuedAt: z.string(),
  planName: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  currency: z.enum(CURRENCIES),
  totalMinor: z.number().int(),
  taxableMinor: z.number().int(),
  cgstMinor: z.number().int(),
  sgstMinor: z.number().int(),
  igstMinor: z.number().int(),
  taxNote: z.string(),
  refundedMinor: z.number().int(),
  sacCode: z.string(),
  buyer: z.object({
    name: z.string(),
    country: z.string(),
    state: z.string().nullable(),
    gstin: z.string().nullable(),
  }),
  seller: z.object({
    name: z.string(),
    address: z.string(),
    gstin: z.string().nullable(),
    state: z.string(),
  }),
});
export const invoiceListSchema = z.object({ invoices: z.array(invoiceSchema) });
export const invoiceParamsSchema = z.strictObject({ invoiceId: idSchema });
export type Invoice = z.infer<typeof invoiceSchema>;
