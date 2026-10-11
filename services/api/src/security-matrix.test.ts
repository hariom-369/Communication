import { afterAll, describe, expect, it } from 'vitest';

import { routeCatalog } from './route-catalog.js';

/**
 * Invariants the security review (docs/security/review.md) relies on, checked over every route.
 * The allow-lists below are the reviewed exceptions: adding a route that falls into one of these
 * categories fails this test until the route is reviewed and added here.
 */
const catalog = routeCatalog();
afterAll(async () => {
  await catalog.close();
});

const changes = (method: string) => method !== 'GET';

describe('user API routes', () => {
  it('have unique ids and unique method + path', () => {
    const ids = catalog.routes.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = catalog.routes.map((route) => `${route.method} ${route.url}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('have a sane rate limit each', () => {
    for (const route of [...catalog.routes, ...catalog.adminRoutes]) {
      expect(route.rateLimit.limit, route.id).toBeGreaterThanOrEqual(1);
      expect(route.rateLimit.burst, route.id).toBeGreaterThanOrEqual(1);
      expect(route.rateLimit.periodMs, route.id).toBeGreaterThanOrEqual(1000);
    }
  });

  it('that change state without a session fail closed when the limiter store is down', () => {
    // Without a session the rate limit is the only brute-force and abuse control. Webhooks are
    // the exception: the provider's signature authenticates them, and refusing them during a
    // limiter outage would only make the provider retry (a per-process limit still applies).
    for (const route of catalog.routes)
      if (route.auth.kind === 'public' && changes(route.method))
        expect(route.rateLimit.onStoreFailure, route.id).toBe('closed');
  });

  it('never record audit entries from GET (GET skips the CSRF checks, so it must not change state)', () => {
    for (const route of catalog.routes)
      if (route.method === 'GET') expect(route.audit.kind, route.id).toBe('none');
  });

  it('without a session are exactly the reviewed ones', () => {
    const unauthenticated = catalog.routes
      .filter((route) => route.auth.kind !== 'session')
      .map((route) => `${route.auth.kind} ${route.id}`)
      .sort();
    expect(unauthenticated).toEqual(REVIEWED_UNAUTHENTICATED);
  });

  it('that require a recent re-authentication are at least the reviewed ones', () => {
    const stepUp = new Set(
      catalog.routes
        .filter((route) => route.auth.kind === 'session' && route.auth.stepUp !== undefined)
        .map((route) => route.id),
    );
    for (const id of REQUIRED_STEP_UP) expect(stepUp.has(id), id).toBe(true);
  });

  it('that add an authentication factor to an active account require re-authentication', () => {
    // A stolen session must not be able to add a factor that outlives it (F-11).
    for (const id of [
      'auth.passkey_register_options',
      'auth.passkey_register_verify',
      'auth.totp_setup',
      'auth.totp_confirm',
      'auth.recovery_codes_regenerate',
    ]) {
      const route = catalog.routes.find((candidate) => candidate.id === id);
      expect(route?.auth.kind === 'session' && route.auth.stepUp !== undefined, id).toBe(true);
    }
  });
});

describe('admin routes', () => {
  it('require a capability unless every admin may use them (reviewed list)', () => {
    const open = catalog.adminRoutes
      .filter((route) => route.auth.kind === 'session' && route.auth.capability === undefined)
      .map((route) => route.id)
      .sort();
    expect(open).toEqual(REVIEWED_ADMIN_WITHOUT_CAPABILITY);
  });

  it('without a session are only the sign-in steps (reviewed list)', () => {
    const open = catalog.adminRoutes
      .filter((route) => route.auth.kind === 'public')
      .map((route) => route.id)
      .sort();
    expect(open).toEqual(REVIEWED_ADMIN_PUBLIC);
    for (const route of catalog.adminRoutes)
      if (route.auth.kind === 'public')
        expect(route.rateLimit.onStoreFailure, route.id).toBe('closed');
  });
});

// Reviewed exceptions (docs/security/review.md §2). Add to a list only after reviewing the route.
const REVIEWED_UNAUTHENTICATED = [
  'public accounts.resend_verification',
  'public accounts.signup',
  'public accounts.verify_email',
  'public auth.login_password',
  'public auth.passkey_login_options',
  'public auth.passkey_login_verify',
  'public auth.password_reset_complete',
  'public auth.password_reset_request',
  'public meta.version',
  'public moderation.grievance',
  'webhook billing.webhook_razorpay',
  'webhook billing.webhook_stripe',
];
const REQUIRED_STEP_UP = [
  'auth.passkey_delete',
  'auth.passkey_register_options',
  'auth.passkey_register_verify',
  'auth.password_change',
  'auth.recovery_codes_regenerate',
  'auth.totp_confirm',
  'auth.totp_disable',
  'auth.totp_setup',
  'backups.add_key',
  'backups.disable',
  'backups.remove_key',
  'channels.delete',
  'channels.request_transfer',
  'communities.delete',
  'communities.transfer',
  'groups.delete',
  'groups.transfer_ownership',
  'keys.approve_link',
  'keys.reset_identity',
  'keys.revoke_device',
  'moderation.abuse_hashes_import',
  'moderation.approve',
  'moderation.legal_order',
  'moderation.revert',
];
// Sign-in steps, sign-out, and the caller's own profile and re-authentication.
const REVIEWED_ADMIN_WITHOUT_CAPABILITY = [
  'admin.key_options',
  'admin.key_verify',
  'admin.logout',
  'admin.me',
  'admin.reauth_options',
  'admin.reauth_verify',
];
const REVIEWED_ADMIN_PUBLIC = ['admin.oidc_callback', 'admin.oidc_start'];
