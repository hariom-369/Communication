import {
  CURRENT_TERMS_VERSION,
  DEFAULT_PRIVACY_SETTINGS,
  meResponseSchema,
} from '@tessera/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../platform/http/routes.js';
import {
  createActiveUser,
  identity,
  startIntegrationApp,
  STRONG_PASSWORD,
  TestClient,
  type IntegrationApp,
} from '../../test/integration-app.js';

let env: IntegrationApp;
beforeAll(async () => {
  env = await startIntegrationApp();
});
afterAll(async () => {
  await env.close();
});

const signupBody = (email: string, username: string) => ({
  email,
  username,
  confirmsAdult: true,
  acceptedTermsVersion: CURRENT_TERMS_VERSION,
});

describe("'accounts.signup', 'accounts.verify_email' and 'auth.password_set_initial'", () => {
  it('sends a code, verifies it into a credential-setup session, and activates on first credential', async () => {
    const { email, username } = identity();
    const client = new TestClient(env.app);

    const signup = await client.post('/api/v1/accounts', signupBody(email, username));
    expect(signup.statusCode).toBe(202);
    expect(signup.json()).toEqual({ status: 'verification_sent' });
    expect(client.cookie).toBeUndefined();

    const verify = await client.post('/api/v1/accounts/verify-email', {
      email,
      code: env.mailer.lastCode(email),
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ stage: 'credential_setup' });

    const cookie = verify.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(cookie).not.toHaveProperty('domain');

    const me = meResponseSchema.parse((await client.get('/api/v1/accounts/me')).json());
    expect(me).toMatchObject({ username, email, status: 'pending_credential' });

    // Only credential setup is possible in this stage.
    expect((await client.get('/api/v1/accounts/me/privacy')).statusCode).toBe(403);

    const setupToken = client.cookie;
    const weak = await client.post('/api/v1/auth/password/initial', { password: 'password1234' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({ code: 'WEAK_PASSWORD' });

    const set = await client.post('/api/v1/auth/password/initial', { password: STRONG_PASSWORD });
    expect(set.statusCode).toBe(200);
    expect(client.cookie).not.toBe(setupToken); // rotated: no session fixation

    const active = meResponseSchema.parse((await client.get('/api/v1/accounts/me')).json());
    expect(active.status).toBe('active');
    expect(active.security).toEqual({
      hasPassword: true,
      passkeyCount: 0,
      totpEnabled: false,
      recoveryCodesRemaining: 0,
    });

    // The setup-stage token no longer works.
    const stale = new TestClient(env.app);
    stale.cookie = setupToken;
    expect((await stale.get('/api/v1/accounts/me')).statusCode).toBe(401);
  });

  it('gives an identical response for existing emails and notifies the owner instead', async () => {
    const existing = await createActiveUser(env);
    const before = env.mailer.to(existing.email).length;
    const attempt = await new TestClient(env.app).post(
      '/api/v1/accounts',
      signupBody(existing.email, identity().username),
    );
    expect(attempt.statusCode).toBe(202);
    expect(attempt.json()).toEqual({ status: 'verification_sent' });
    const notices = env.mailer.to(existing.email).slice(before);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).not.toMatch(/verification code/);
  });

  it('rejects taken, reserved and malformed usernames and requires the adult confirmation', async () => {
    const existing = await createActiveUser(env);
    const client = new TestClient(env.app);
    const taken = await client.post(
      '/api/v1/accounts',
      signupBody(identity().email, existing.username.toUpperCase()),
    );
    expect(taken.json()).toMatchObject({ code: 'USERNAME_TAKEN', status: 409 });
    for (const username of ['admin', 'tessera_support', 'ab', '9starts_with_digit', 'has-dash']) {
      const response = await client.post(
        '/api/v1/accounts',
        signupBody(identity().email, username),
      );
      expect(response.statusCode, username).toBe(400);
    }
    const minor = await client.post('/api/v1/accounts', {
      ...signupBody(identity().email, identity().username),
      confirmsAdult: false,
    });
    expect(minor.statusCode).toBe(400);
  });

  it('limits code attempts and accepts only the latest code', async () => {
    const { email, username } = identity();
    const client = new TestClient(env.app);
    await client.post('/api/v1/accounts', signupBody(email, username));
    const first = env.mailer.lastCode(email);
    const wrong = first === '000000' ? '111111' : '000000';

    await client.post('/api/v1/accounts/resend-verification', { email });
    const second = env.mailer.lastCode(email);
    if (first !== second) {
      const old = await client.post('/api/v1/accounts/verify-email', { email, code: first });
      expect(old.json()).toMatchObject({ code: 'INVALID_CODE' });
    }
    for (let i = 0; i < 5; i++) {
      const response = await client.post('/api/v1/accounts/verify-email', { email, code: wrong });
      expect(response.json()).toMatchObject({ code: 'INVALID_CODE' });
    }
    // Attempts exhausted: even the right code fails now.
    const exhausted = await client.post('/api/v1/accounts/verify-email', { email, code: second });
    expect(exhausted.json()).toMatchObject({ code: 'INVALID_CODE' });
    expect(client.cookie).toBeUndefined();
  });

  it("'accounts.resend_verification' answers identically and only mails pending accounts", async () => {
    const active = await createActiveUser(env);
    const unknown = identity().email;
    const client = new TestClient(env.app);
    const before = env.mailer.sent.length;
    for (const email of [active.email, unknown]) {
      const response = await client.post('/api/v1/accounts/resend-verification', { email });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: 'verification_sent' });
    }
    expect(env.mailer.sent.length).toBe(before);
  });

  it('answers unknown emails exactly like wrong codes', async () => {
    const response = await new TestClient(env.app).post('/api/v1/accounts/verify-email', {
      email: identity().email,
      code: '123456',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_CODE' });
  });

  it('lets many people behind one shared IP (carrier-grade NAT) sign up and secure accounts', async () => {
    const sharedIp = '100.64.10.20';
    for (let i = 0; i < 25; i++) {
      const { email, username } = identity();
      const client = new TestClient(env.app, { ip: sharedIp });
      expect((await client.post('/api/v1/accounts', signupBody(email, username))).statusCode).toBe(
        202,
      );
      expect(
        (
          await client.post('/api/v1/accounts/verify-email', {
            email,
            code: env.mailer.lastCode(email),
          })
        ).statusCode,
      ).toBe(200);
      const set = await client.post('/api/v1/auth/password/initial', { password: STRONG_PASSWORD });
      expect(set.statusCode, `user ${i}: ${set.body}`).toBe(200);
    }
  });

  it('stores only a digest of verification codes', async () => {
    const { email, username } = identity();
    await new TestClient(env.app).post('/api/v1/accounts', signupBody(email, username));
    const code = env.mailer.lastCode(email);
    const rows = await env.db.selectFrom('email_verifications').select('code_digest').execute();
    for (const row of rows) expect(row.code_digest.toString('utf8')).not.toContain(code);
  });
});

describe("'accounts.me', 'accounts.privacy_get' and 'accounts.privacy_update'", () => {
  it('requires a session', async () => {
    const anonymous = new TestClient(env.app);
    expect((await anonymous.get('/api/v1/accounts/me')).json()).toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect((await anonymous.get('/api/v1/accounts/me/privacy')).statusCode).toBe(401);
  });

  it('returns protective defaults and stores validated updates', async () => {
    const { client } = await createActiveUser(env);
    expect((await client.get('/api/v1/accounts/me/privacy')).json()).toEqual(
      DEFAULT_PRIVACY_SETTINGS,
    );

    const updated = { ...DEFAULT_PRIVACY_SETTINGS, lastSeen: 'nobody', readReceipts: false };
    expect((await client.put('/api/v1/accounts/me/privacy', updated)).statusCode).toBe(200);
    expect((await client.get('/api/v1/accounts/me/privacy')).json()).toEqual(updated);

    const invalid = await client.put('/api/v1/accounts/me/privacy', {
      ...updated,
      lastSeen: 'public',
    });
    expect(invalid.statusCode).toBe(400);
    const partial = await client.put('/api/v1/accounts/me/privacy', { lastSeen: 'nobody' });
    expect(partial.statusCode).toBe(400);
  });

  it('never exposes internal fields', async () => {
    const { client } = await createActiveUser(env);
    const body = (await client.get('/api/v1/accounts/me')).body;
    expect(body).not.toMatch(/argon2|hash|digest|token|accepted_terms|confirmed_adult/i);
  });
});
