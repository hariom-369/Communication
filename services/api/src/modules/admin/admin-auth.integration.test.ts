import { randomBytes } from 'node:crypto';

import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAdminCommand } from '../../cli/admin-command.js';
import { testVendor } from '../../test/attestation.js';
import {
  ADMIN_ORIGIN,
  ADMIN_RP_ID,
  AdminTestClient,
  TEST_AAGUID,
  makeAdmin,
  newKey,
  oidcStep,
  signIn,
  startAdminApp,
  stepUp,
  type AdminTestEnv,
} from '../../test/admin-app.js';
import {
  ORIGIN,
  TestClient,
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';
import { SoftwareAuthenticator } from '../../test/webauthn-authenticator.js';
import { ADMIN_FLOW_COOKIE, ADMIN_SESSION_COOKIE } from '../../platform/http/admin-routes.js';

/**
 * Admin sign-in and sessions (docs/admin.md §1, ADR-050): the corporate identity provider (OIDC
 * authorization code with PKCE, state and nonce; verified email on an allowed domain; the
 * subject bound at first sign-in), then a hardware-bound security key (synced passkeys refused;
 * the key-model allow-list checked against vendor attestation). Sessions: 30 minutes idle,
 * 8 hours absolute, token replaced on activation, separate cookie and origin, step-up for
 * sensitive actions.
 */

let env: IntegrationApp;
let admin: AdminTestEnv;

beforeAll(async () => {
  env = await startIntegrationApp();
  admin = await startAdminApp(env);
});
afterAll(async () => {
  await admin.close();
  await env.close();
});

const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;

async function newAdmin(email = `a_${randomBytes(4).toString('hex')}@tessera.test`) {
  const created = await admin.admin.directory.create({
    email,
    displayName: 'Staff',
    createdBy: 'test',
  });
  await admin.admin.directory.grant({
    adminId: created.id,
    role: 'analyst',
    hours: 24,
    grantedBy: 'test',
    approvalId: null,
  });
  return { id: created.id, email, subject: `sub-${created.id}` };
}

describe('identity provider step', () => {
  it('uses the authorization code flow with PKCE (S256), state and nonce', async () => {
    const client = new AdminTestClient(admin.app);
    const started = await client.post('/admin/v1/auth/oidc/start');
    expect(started.statusCode).toBe(200);
    const url = new URL(started.json<{ authorizationUrl: string }>().authorizationUrl);
    expect(url.origin).toBe(admin.idp.issuer);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url.searchParams.get('scope')?.split(' ')).toContain('openid');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ADMIN_ORIGIN}/auth/callback`);
    // The flow id rides in a strict, host-only cookie; the verifier never leaves the server.
    const flow = started.cookies.find((cookie) => cookie.name === ADMIN_FLOW_COOKIE);
    expect(flow).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(started.body).not.toContain('verifier');
  });

  it('signs a known admin in, binding their identity-provider subject', async () => {
    const person = await newAdmin();
    const client = new AdminTestClient(admin.app);
    const callback = await oidcStep(admin, client, {
      subject: person.subject,
      email: person.email,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toEqual({ stage: 'key_setup' });
    const session = callback.cookies.find((cookie) => cookie.name === ADMIN_SESSION_COOKIE);
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(session?.['domain']).toBeUndefined();
    const row = await env.db
      .selectFrom('admin_users')
      .select(['oidc_issuer', 'oidc_subject'])
      .where('id', '=', person.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ oidc_issuer: admin.idp.issuer, oidc_subject: person.subject });

    // Another identity-provider account with the same email is not the same person.
    const impostor = new AdminTestClient(admin.app);
    const refused = await oidcStep(admin, impostor, {
      subject: 'someone-else',
      email: person.email,
    });
    expect(refused.statusCode).toBe(403);
    expect(impostor.cookies.has(ADMIN_SESSION_COOKIE)).toBe(false);
  });

  it('refuses unknown people, unverified emails, other domains and disabled admins', async () => {
    const unknown = await oidcStep(admin, new AdminTestClient(admin.app), {
      subject: 'nobody',
      email: 'nobody@tessera.test',
    });
    expect(unknown.statusCode).toBe(403);

    const person = await newAdmin();
    const unverified = await oidcStep(admin, new AdminTestClient(admin.app), {
      subject: person.subject,
      email: person.email,
      emailVerified: false,
    });
    expect(unverified.statusCode).toBe(403);

    const outsider = await newAdmin(`a_${randomBytes(4).toString('hex')}@elsewhere.test`);
    const otherDomain = await oidcStep(admin, new AdminTestClient(admin.app), {
      subject: outsider.subject,
      email: outsider.email,
    });
    expect(otherDomain.statusCode).toBe(403);

    await admin.admin.directory.disable(person.id);
    const disabled = await oidcStep(admin, new AdminTestClient(admin.app), {
      subject: person.subject,
      email: person.email,
    });
    expect(disabled.statusCode).toBe(403);
    const refusals = await env.db
      .selectFrom('audit_log')
      .select(['actor_id', 'details'])
      .where('action', '=', 'admin.oidc_callback')
      .execute();
    expect(
      refusals.filter((r) => (r.details as { outcome: string }).outcome === 'FORBIDDEN'),
    ).toHaveLength(5); // including the impostor above
  });

  it.each(['wrong_nonce', 'wrong_audience', 'wrong_issuer', 'expired'] as const)(
    'refuses an ID token with %s',
    async (misbehaviour) => {
      const person = await newAdmin();
      admin.idp.misbehave = misbehaviour;
      try {
        const client = new AdminTestClient(admin.app);
        const callback = await oidcStep(admin, client, {
          subject: person.subject,
          email: person.email,
        });
        expect(callback.statusCode).toBe(401);
        expect(code(callback)).toBe('INVALID_CREDENTIALS');
        expect(client.cookies.has(ADMIN_SESSION_COOKIE)).toBe(false);
      } finally {
        admin.idp.misbehave = null;
      }
    },
  );

  it('refuses a changed state, a missing flow cookie and a replayed flow', async () => {
    const person = await newAdmin();
    admin.idp.identity = { subject: person.subject, email: person.email };
    const client = new AdminTestClient(admin.app);
    const started = await client.post('/admin/v1/auth/oidc/start');
    const authorize = await fetch(started.json<{ authorizationUrl: string }>().authorizationUrl, {
      redirect: 'manual',
    });
    const location = new URL(authorize.headers.get('location') ?? '');
    const codeValue = location.searchParams.get('code') ?? '';
    const state = location.searchParams.get('state') ?? '';
    const flow = client.cookies.get(ADMIN_FLOW_COOKIE) ?? '';

    const tampered = await client.post('/admin/v1/auth/oidc/callback', {
      code: codeValue,
      state: `${state}x`,
    });
    expect(tampered.statusCode).toBe(401);
    // The flow was consumed by the failed attempt: the right state no longer works either.
    client.cookies.set(ADMIN_FLOW_COOKIE, flow);
    const replay = await client.post('/admin/v1/auth/oidc/callback', { code: codeValue, state });
    expect(replay.statusCode).toBe(401);

    const noCookie = new AdminTestClient(admin.app);
    const missing = await noCookie.post('/admin/v1/auth/oidc/callback', { code: codeValue, state });
    expect(missing.statusCode).toBe(401);
  });
});

describe('security key step', () => {
  it('registers a key on first sign-in, then requires it; the session token is replaced', async () => {
    const person = await newAdmin();
    const client = new AdminTestClient(admin.app);
    const key = newKey();
    await oidcStep(admin, client, { subject: person.subject, email: person.email });
    const halfToken = client.cookies.get(ADMIN_SESSION_COOKIE) ?? '';

    // Half signed in: no roles, nothing but the key step.
    expect((await client.get('/admin/v1/me')).statusCode).toBe(403);
    expect((await client.get('/admin/v1/dashboard')).statusCode).toBe(403);

    const options = await client.post('/admin/v1/auth/key/options');
    const { flowId, options: publicKey } = options.json<{
      flowId: string;
      options: { attestation: string; authenticatorSelection: Record<string, string> };
    }>();
    expect(publicKey.attestation).toBe('direct');
    expect(publicKey.authenticatorSelection).toMatchObject({ userVerification: 'required' });
    const verified = await client.post('/admin/v1/auth/key/verify', {
      flowId,
      response: key.register(publicKey),
      name: 'Desk key',
    });
    expect(verified.json()).toEqual({ stage: 'active' });
    const fullToken = client.cookies.get(ADMIN_SESSION_COOKIE) ?? '';
    expect(fullToken).not.toBe(halfToken);

    const me = await client.get('/admin/v1/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      id: person.id,
      email: person.email,
      roles: [{ role: 'analyst' }],
      capabilities: expect.arrayContaining(['dashboard', 'analytics']) as unknown,
    });

    // The half-signed-in token stopped working when the session was activated.
    const stale = new AdminTestClient(admin.app);
    stale.cookies.set(ADMIN_SESSION_COOKIE, halfToken);
    expect((await stale.get('/admin/v1/me')).statusCode).toBe(401);

    // Next time the identity provider step leads to the key, and only that key works.
    const again = new AdminTestClient(admin.app);
    const callback = await oidcStep(admin, again, { subject: person.subject, email: person.email });
    expect(callback.json()).toEqual({ stage: 'key' });
    const login = (await again.post('/admin/v1/auth/key/options')).json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    const otherKey = newKey();
    const wrong = await again.post('/admin/v1/auth/key/verify', {
      flowId: login.flowId,
      response: otherKey.assert(login.options),
    });
    expect(wrong.statusCode).toBe(401);
    await signIn(admin, again, { subject: person.subject, email: person.email }, key);
    expect((await again.get('/admin/v1/me')).statusCode).toBe(200);
  });

  it('refuses synced passkeys and keys without user verification', async () => {
    const person = await newAdmin();
    const client = new AdminTestClient(admin.app);
    await oidcStep(admin, client, { subject: person.subject, email: person.email });
    const first = (await client.post('/admin/v1/auth/key/options')).json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    const synced = await client.post('/admin/v1/auth/key/verify', {
      flowId: first.flowId,
      response: newKey({ hardwareBound: false }).register(first.options),
    });
    expect(synced.statusCode).toBe(403);
    expect(synced.json<{ detail: string }>().detail).toMatch(/hardware security key/);

    const second = (await client.post('/admin/v1/auth/key/options')).json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    const noUv = new SoftwareAuthenticator({
      rpId: ADMIN_RP_ID,
      origin: ADMIN_ORIGIN,
      userVerified: false,
      hardwareBound: { aaguid: TEST_AAGUID },
    });
    const unverified = await client.post('/admin/v1/auth/key/verify', {
      flowId: second.flowId,
      response: noUv.register(second.options),
    });
    expect(unverified.statusCode).toBe(401);

    const third = (await client.post('/admin/v1/auth/key/options')).json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    const phished = await client.post('/admin/v1/auth/key/verify', {
      flowId: third.flowId,
      response: newKey().register(third.options, { origin: ORIGIN }),
    });
    expect(phished.statusCode).toBe(401);
    // Still half signed in.
    expect((await client.get('/admin/v1/me')).statusCode).toBe(403);
    const keys = await env.db
      .selectFrom('admin_credentials')
      .select('id')
      .where('admin_id', '=', person.id)
      .execute();
    expect(keys).toHaveLength(0);
  });

  it('a key flow belongs to the session that started it', async () => {
    const a = await newAdmin();
    const b = await newAdmin();
    const clientA = new AdminTestClient(admin.app);
    const clientB = new AdminTestClient(admin.app);
    await oidcStep(admin, clientA, { subject: a.subject, email: a.email });
    await oidcStep(admin, clientB, { subject: b.subject, email: b.email });
    const optionsA = (await clientA.post('/admin/v1/auth/key/options')).json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    const stolen = await clientB.post('/admin/v1/auth/key/verify', {
      flowId: optionsA.flowId,
      response: newKey().register(optionsA.options),
    });
    expect(stolen.statusCode).toBe(401);
  });
});

describe('security key model allow-list', () => {
  const aaguidText = [
    TEST_AAGUID.subarray(0, 4),
    TEST_AAGUID.subarray(4, 6),
    TEST_AAGUID.subarray(6, 8),
    TEST_AAGUID.subarray(8, 10),
    TEST_AAGUID.subarray(10),
  ]
    .map((part) => part.toString('hex'))
    .join('-');
  let strict: AdminTestEnv;
  let vendor: Awaited<ReturnType<typeof testVendor>>;

  beforeAll(async () => {
    vendor = await testVendor(TEST_AAGUID);
    strict = await startAdminApp(env, {
      aaguids: [aaguidText],
      attestationRoots: [vendor.rootPem],
    });
  });
  afterAll(async () => {
    await strict.close();
  });

  async function register(
    key: ReturnType<typeof newKey>,
  ): Promise<{ statusCode: number; body: string }> {
    const person = await newAdmin();
    const client = new AdminTestClient(strict.app);
    await oidcStep(strict, client, { subject: person.subject, email: person.email });
    const options = (await client.post('/admin/v1/auth/key/options')).json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    return client.post('/admin/v1/auth/key/verify', {
      flowId: options.flowId,
      response: key.register(options.options),
    });
  }

  it('accepts a listed model whose attestation chains to the vendor root', async () => {
    const accepted = await register(newKey({ attestation: vendor }));
    expect(accepted.statusCode).toBe(200);
  });

  it('refuses keys that cannot prove a listed model', async () => {
    // No attestation at all, or the key vouching for itself.
    expect((await register(newKey())).statusCode).toBe(403);
    expect((await register(newKey({ attestation: 'self' }))).statusCode).toBe(403);
    // Attested, but a model not on the list.
    const otherModel = randomBytes(16);
    const otherVendor = await testVendor(otherModel);
    expect(
      (await register(newKey({ aaguid: otherModel, attestation: otherVendor }))).statusCode,
    ).toBe(403);
    // A listed model id, attested by a vendor whose root is not trusted.
    const rogue = await testVendor(TEST_AAGUID);
    expect((await register(newKey({ attestation: rogue }))).statusCode).toBe(403);
    // A trusted chain whose certificate does not name the model.
    const unnamed = await testVendor(TEST_AAGUID, { aaguidExtension: false });
    const strictUnnamed = await startAdminApp(env, {
      aaguids: [aaguidText],
      attestationRoots: [unnamed.rootPem],
    });
    try {
      const person = await newAdmin();
      const client = new AdminTestClient(strictUnnamed.app);
      await oidcStep(strictUnnamed, client, { subject: person.subject, email: person.email });
      const options = (await client.post('/admin/v1/auth/key/options')).json<{
        flowId: string;
        options: Record<string, unknown>;
      }>();
      const refused = await client.post('/admin/v1/auth/key/verify', {
        flowId: options.flowId,
        response: newKey({ attestation: unnamed }).register(options.options),
      });
      expect(refused.statusCode).toBe(403);
    } finally {
      await strictUnnamed.close();
    }
  });
});

describe('admin sessions', () => {
  it('end after 30 minutes idle and 8 hours in all', async () => {
    const idle = await makeAdmin(admin, ['analyst']);
    await env.db
      .updateTable('admin_sessions')
      .set({ last_seen_at: new Date(Date.now() - 31 * 60_000) })
      .where('admin_id', '=', idle.id)
      .execute();
    expect((await idle.client.get('/admin/v1/me')).statusCode).toBe(401);
    const revoked = await env.db
      .selectFrom('admin_sessions')
      .select('revoked_at')
      .where('admin_id', '=', idle.id)
      .executeTakeFirstOrThrow();
    expect(revoked.revoked_at).not.toBeNull();

    const old = await makeAdmin(admin, ['analyst']);
    const session = await env.db
      .selectFrom('admin_sessions')
      .select(['created_at', 'expires_at'])
      .where('admin_id', '=', old.id)
      .executeTakeFirstOrThrow();
    expect(session.expires_at.getTime() - session.created_at.getTime()).toBeLessThanOrEqual(
      8 * 3_600_000 + 1_000,
    );
    await env.db
      .updateTable('admin_sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('admin_id', '=', old.id)
      .execute();
    expect((await old.client.get('/admin/v1/me')).statusCode).toBe(401);
  });

  it('roles apply at once: an expired grant or a disabled admin loses access mid-session', async () => {
    const person = await makeAdmin(admin, ['analyst']);
    expect((await person.client.get('/admin/v1/analytics/signups')).statusCode).toBe(200);
    await env.db
      .updateTable('admin_role_grants')
      .set({ expires_at: new Date(Date.now() - 1000), starts_at: new Date(Date.now() - 2000) })
      .where('admin_id', '=', person.id)
      .execute();
    expect((await person.client.get('/admin/v1/analytics/signups')).statusCode).toBe(403);
    expect((await person.client.get('/admin/v1/me')).json()).toMatchObject({
      roles: [],
      capabilities: [],
    });

    const other = await makeAdmin(admin, ['analyst']);
    await admin.admin.directory.disable(other.id);
    expect((await other.client.get('/admin/v1/me')).statusCode).toBe(401);
  });

  it('sign out ends the session', async () => {
    const person = await makeAdmin(admin, ['analyst']);
    const out = await person.client.post('/admin/v1/auth/logout');
    expect(out.statusCode).toBe(200);
    expect(person.client.cookies.has(ADMIN_SESSION_COOKIE)).toBe(false);
    const token = await env.db
      .selectFrom('admin_sessions')
      .select('revoked_at')
      .where('admin_id', '=', person.id)
      .executeTakeFirstOrThrow();
    expect(token.revoked_at).not.toBeNull();
  });

  it('sensitive actions need the key again after five minutes', async () => {
    const security = await makeAdmin(admin, ['security_admin']);
    const target = await makeAdmin(admin, ['analyst']);
    await env.db
      .updateTable('admin_sessions')
      .set({ reauthenticated_at: new Date(Date.now() - 6 * 60_000) })
      .where('admin_id', '=', security.id)
      .execute();
    const blocked = await security.client.post(`/admin/v1/admins/${target.id}/disable`);
    expect(blocked.statusCode).toBe(403);
    expect(code(blocked)).toBe('STEP_UP_REQUIRED');
    expect((await security.client.get('/admin/v1/me')).json()).toMatchObject({
      stepUpUntil: null,
    });

    // Someone else's key does not count.
    const options = (await security.client.post('/admin/v1/auth/reauth/options')).json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    const wrong = await security.client.post('/admin/v1/auth/reauth/verify', {
      flowId: options.flowId,
      response: target.key.assert(options.options),
    });
    expect(wrong.statusCode).toBe(401);

    await stepUp(security.client, security.key);
    expect(
      (await security.client.get('/admin/v1/me')).json<{ stepUpUntil: string | null }>()
        .stepUpUntil,
    ).not.toBeNull();
    expect((await security.client.post(`/admin/v1/admins/${target.id}/disable`)).statusCode).toBe(
      200,
    );
    expect((await target.client.get('/admin/v1/me')).statusCode).toBe(401);
  });
});

describe('separation from the user API', () => {
  it('admin and user sessions, origins and routes do not mix', async () => {
    const person = await makeAdmin(admin, ['super_admin']);
    const user = await createActiveUser(env);

    // The user API does not serve admin routes, and the admin API does not serve user routes.
    expect((await user.client.get('/admin/v1/me')).statusCode).toBe(404);
    expect((await person.client.get('/api/v1/accounts/me')).statusCode).toBe(404);

    // An admin session cookie means nothing to the user API.
    const adminToken = person.client.cookies.get(ADMIN_SESSION_COOKIE) ?? '';
    const userApi = new TestClient(env.app);
    const asAdmin = await env.app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { origin: ORIGIN, cookie: `${ADMIN_SESSION_COOKIE}=${adminToken}` },
    });
    expect(asAdmin.statusCode).toBe(401);
    expect(userApi.cookie).toBeUndefined();

    // A user session token is not an admin session, under either cookie name.
    const userToken = user.client.cookie ?? '';
    const asUser = new AdminTestClient(admin.app);
    asUser.cookies.set(ADMIN_SESSION_COOKIE, userToken);
    expect((await asUser.get('/admin/v1/me')).statusCode).toBe(401);

    // Requests from the user app's origin are refused by the admin API.
    const crossOrigin = new AdminTestClient(admin.app, { origin: ORIGIN });
    for (const [name, value] of person.client.cookies) crossOrigin.cookies.set(name, value);
    expect((await crossOrigin.post('/admin/v1/auth/reauth/options')).statusCode).toBe(403);
    const preflight = await admin.app.inject({
      method: 'OPTIONS',
      url: '/admin/v1/me',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('every admin response carries the security headers and no caching', async () => {
    const person = await makeAdmin(admin, ['analyst']);
    const response = await person.client.get('/admin/v1/me');
    expect(response.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toMatch(/no-store/);
  });
});

describe('operator command (break glass)', () => {
  it('bootstraps admins and roles, capped and audited', async () => {
    const email = `ops_${randomBytes(4).toString('hex')}@tessera.test`;
    const run = (...args: string[]) => runAdminCommand(env.db, env.modules.audit, args);
    expect((await run('create', email, 'First Admin')).code).not.toBe(0); // --by is required
    expect((await run('create', email, 'First Admin', '--by', 'ops-oncall')).code).toBe(0);
    expect(
      (await run('grant', email, 'super_admin', '--hours', '9', '--by', 'ops-oncall')).code,
    ).not.toBe(0);
    expect(
      (await run('grant', email, 'super_admin', '--hours', '8', '--by', 'ops-oncall')).code,
    ).toBe(0);
    expect(
      (await run('grant', email, 'wizard', '--hours', '1', '--by', 'ops-oncall')).code,
    ).not.toBe(0);
    expect((await run('eligible', email, 'security_admin', '--by', 'ops-oncall')).code).toBe(0);
    const listed = await run('list');
    expect(listed.output).toContain(email);
    expect(listed.output).toContain('super_admin until');
    expect(listed.output).toContain('eligible: security_admin');

    const created = await admin.admin.directory.byEmail(email);
    expect(created?.eligible_roles).toEqual(['security_admin']);
    const entries = await env.db
      .selectFrom('audit_log')
      .select(['actor_kind', 'action', 'details'])
      .where('target_id', '=', created?.id ?? '')
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => e.action)).toEqual([
      'admin.operator_create',
      'admin.operator_grant',
      'admin.operator_eligibility',
    ]);
    expect(entries.every((e) => e.actor_kind === 'system')).toBe(true);
    expect(entries[0]?.details).toMatchObject({ by: 'ops-oncall', via: 'operator_command' });

    expect((await run('disable', email, '--by', 'ops-oncall')).code).toBe(0);
    expect((await admin.admin.directory.byEmail(email))?.status).toBe('disabled');
    expect(await admin.admin.directory.roles(created?.id ?? '')).toEqual([]);
  });
});
