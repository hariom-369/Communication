import { Secret, TOTP } from 'otpauth';
import { CURRENT_TERMS_VERSION, meResponseSchema, sessionListSchema } from '@tessera/validation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createActiveUser,
  identity,
  ORIGIN,
  RP_ID,
  startIntegrationApp,
  TestClient,
  type IntegrationApp,
} from '../../test/integration-app.js';
import { SoftwareAuthenticator } from '../../test/webauthn-authenticator.js';

let env: IntegrationApp;
beforeAll(async () => {
  env = await startIntegrationApp();
});
afterAll(async () => {
  await env.close();
});

const NEW_PASSWORD = 'another-long-unusual-passphrase-47';

function totpCode(secret: string, offsetSteps = 0): string {
  return new TOTP({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate({
    timestamp: Date.now() + offsetSteps * 30_000,
  });
}

async function login(identifier: string, password: string, client = new TestClient(env.app)) {
  const response = await client.post('/api/v1/auth/login', { identifier, password });
  return { client, response };
}

async function reauth(client: TestClient, password: string, extra: Record<string, string> = {}) {
  const response = await client.post('/api/v1/auth/reauth/password', { password, ...extra });
  expect(response.statusCode, response.body).toBe(200);
}

async function enableTotp(
  client: TestClient,
  password: string,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  await reauth(client, password);
  const setup = await client.post('/api/v1/auth/totp/setup');
  expect(setup.statusCode, setup.body).toBe(200);
  const { secret, otpauthUri } = setup.json<{ secret: string; otpauthUri: string }>();
  expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/Tessera:/);
  const confirm = await client.post('/api/v1/auth/totp/confirm', { code: totpCode(secret) });
  expect(confirm.statusCode, confirm.body).toBe(200);
  return { secret, recoveryCodes: confirm.json<{ recoveryCodes: string[] }>().recoveryCodes };
}

describe("'auth.login_password'", () => {
  it('signs in with email or username and rotates the token on each login', async () => {
    const user = await createActiveUser(env);
    const byEmail = await login(user.email, user.password);
    expect(byEmail.response.json()).toEqual({ stage: 'active' });
    const byUsername = await login(user.username.toUpperCase(), user.password);
    expect(byUsername.response.json()).toEqual({ stage: 'active' });
    expect(byEmail.client.cookie).not.toBe(byUsername.client.cookie);
    expect((await byUsername.client.get('/api/v1/accounts/me')).statusCode).toBe(200);
  });

  it('gives identical errors for wrong passwords and unknown accounts', async () => {
    const user = await createActiveUser(env);
    const wrong = await login(user.email, 'wrong-password-123456');
    const unknown = await login(identity().email, 'wrong-password-123456');
    expect(wrong.response.statusCode).toBe(401);
    expect(unknown.response.statusCode).toBe(401);
    const strip = (body: string) => {
      const { requestId: _r, ...rest } = JSON.parse(body) as Record<string, unknown>;
      return rest;
    };
    expect(strip(wrong.response.body)).toEqual(strip(unknown.response.body));
    expect(wrong.client.cookie).toBeUndefined();
  });

  it('locks an identifier after repeated failures, even for the right password', async () => {
    const user = await createActiveUser(env);
    for (let i = 0; i < 5; i++) {
      // Different IPs: the per-identifier limit must hold against distributed guessing.
      const attempt = await login(
        user.email,
        `wrong-password-${i}-abcdef`,
        new TestClient(env.app),
      );
      expect(attempt.response.statusCode).toBe(401);
    }
    const blocked = await login(user.email, user.password, new TestClient(env.app));
    expect(blocked.response.statusCode).toBe(429);
    expect(blocked.response.headers['retry-after']).toBeDefined();
  });

  it('records failures and successes as security events', async () => {
    const user = await createActiveUser(env);
    await login(user.email, 'wrong-password-123456');
    await login(user.email, user.password);
    const events = await env.db
      .selectFrom('login_events')
      .innerJoin('users', 'users.id', 'login_events.user_id')
      .select(['kind', 'method'])
      .where('users.username', '=', user.username)
      .orderBy('login_events.created_at')
      .execute();
    expect(events.map((e) => `${e.kind}:${e.method}`)).toEqual([
      'failure:password',
      'success:password',
    ]);
  });

  it('sends a new sign-in alert only for unfamiliar browser/network combinations', async () => {
    const user = await createActiveUser(env);
    await login(user.email, user.password, new TestClient(env.app, { ip: '203.0.113.10' }));
    const before = env.mailer.to(user.email).length;
    await login(user.email, user.password, new TestClient(env.app, { ip: '203.0.113.11' })); // same /24 + UA
    expect(env.mailer.to(user.email).length).toBe(before);
    await login(
      user.email,
      user.password,
      new TestClient(env.app, {
        ip: '192.0.2.50',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1',
      }),
    );
    const alert = env.mailer.to(user.email).at(-1);
    expect(alert?.subject).toContain('New sign-in');
    expect(alert?.text).toContain('Safari on iOS');
    expect(alert?.text).toContain('192.0.2.0/24');
  });

  it('rejects state-changing requests without the CSRF header', async () => {
    const user = await createActiveUser(env);
    const response = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ identifier: user.email, password: user.password }),
    });
    expect(response.json()).toMatchObject({ code: 'CSRF_REJECTED' });
  });
});

describe('storage at rest', () => {
  it('keeps no raw secrets in the database', async () => {
    const user = await createActiveUser(env);
    const { secret } = await enableTotp(user.client, user.password);
    const userId = meResponseSchema.parse((await user.client.get('/api/v1/accounts/me')).json()).id;

    const password = await env.db
      .selectFrom('password_credentials')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(password.hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(password.hash).not.toContain(user.password);

    const totp = await env.db
      .selectFrom('totp_credentials')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(totp.secret_encrypted).toMatch(/^v1\.k1\./);
    expect(totp.secret_encrypted).not.toContain(secret);

    const sessions = await env.db
      .selectFrom('sessions')
      .select('token_digest')
      .where('user_id', '=', userId)
      .execute();
    for (const session of sessions) {
      expect(session.token_digest).toHaveLength(32);
      expect(session.token_digest.toString('base64url')).not.toBe(user.client.cookie);
    }
  });
});

describe("'auth.reauth_password' and step-up", () => {
  it('requires recent re-authentication for sensitive changes', async () => {
    const user = await createActiveUser(env);
    const fresh = await login(user.email, user.password);
    // Login itself counts as recent authentication…
    expect((await fresh.client.post('/api/v1/auth/totp/setup')).statusCode).toBe(200);
    // …but a session older than the window does not.
    await env.db
      .updateTable('sessions')
      .set({ reauthenticated_at: new Date(Date.now() - 11 * 60_000) })
      .execute();
    const stale = await fresh.client.put('/api/v1/auth/password', { password: NEW_PASSWORD });
    expect(stale.json()).toMatchObject({ code: 'STEP_UP_REQUIRED', status: 403 });

    const wrong = await fresh.client.post('/api/v1/auth/reauth/password', {
      password: 'not-my-password-000',
    });
    expect(wrong.statusCode).toBe(401);
    await reauth(fresh.client, user.password);
    expect(
      (await fresh.client.put('/api/v1/auth/password', { password: NEW_PASSWORD })).statusCode,
    ).toBe(200);
  });
});

describe("'auth.password_change'", () => {
  it('signs out every other session and notifies the user', async () => {
    const user = await createActiveUser(env);
    const other = await login(user.email, user.password);
    await reauth(user.client, user.password);
    const change = await user.client.put('/api/v1/auth/password', { password: NEW_PASSWORD });
    expect(change.statusCode).toBe(200);
    expect((await user.client.get('/api/v1/accounts/me')).statusCode).toBe(200);
    expect((await other.client.get('/api/v1/accounts/me')).statusCode).toBe(401);
    expect(env.mailer.to(user.email).at(-1)?.subject).toContain('password was changed');
    expect((await login(user.email, user.password)).response.statusCode).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).response.statusCode).toBe(200);
  });
});

describe("'auth.totp_setup', 'auth.totp_confirm', 'auth.login_mfa'", () => {
  it('requires a second factor after TOTP is enabled, with replay protection', async () => {
    const user = await createActiveUser(env);
    const { secret, recoveryCodes } = await enableTotp(user.client, user.password);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);

    const first = await login(user.email, user.password);
    expect(first.response.json()).toEqual({ stage: 'mfa_pending' });
    // The half-authenticated session cannot do anything but finish MFA.
    expect((await first.client.get('/api/v1/accounts/me')).statusCode).toBe(403);
    expect((await first.client.get('/api/v1/auth/sessions')).statusCode).toBe(403);

    const bad = await first.client.post('/api/v1/auth/login/mfa', {
      totpCode: '000000' === totpCode(secret) ? '111111' : '000000',
    });
    expect(bad.json()).toMatchObject({ code: 'INVALID_CODE' });

    // The code used to confirm enrolment cannot be replayed; the next time step works.
    const replayed = await first.client.post('/api/v1/auth/login/mfa', {
      totpCode: totpCode(secret),
    });
    expect(replayed.json()).toMatchObject({ code: 'INVALID_CODE' });
    const next = await first.client.post('/api/v1/auth/login/mfa', {
      totpCode: totpCode(secret, 1),
    });
    expect(next.json()).toEqual({ stage: 'active' });
    expect((await first.client.get('/api/v1/accounts/me')).statusCode).toBe(200);

    const second = await login(user.email, user.password);
    const again = await second.client.post('/api/v1/auth/login/mfa', {
      totpCode: totpCode(secret, 1),
    });
    expect(again.json()).toMatchObject({ code: 'INVALID_CODE' });
  });

  it('accepts each recovery code exactly once', async () => {
    const user = await createActiveUser(env);
    const { recoveryCodes } = await enableTotp(user.client, user.password);
    const code = recoveryCodes[0]!;

    const first = await login(user.email, user.password);
    const used = await first.client.post('/api/v1/auth/login/mfa', {
      recoveryCode: code.toLowerCase(),
    });
    expect(used.json()).toEqual({ stage: 'active' });
    const me = meResponseSchema.parse((await first.client.get('/api/v1/accounts/me')).json());
    expect(me.security.recoveryCodesRemaining).toBe(9);

    const second = await login(user.email, user.password);
    const reused = await second.client.post('/api/v1/auth/login/mfa', { recoveryCode: code });
    expect(reused.json()).toMatchObject({ code: 'INVALID_CODE' });
  });

  it('limits MFA guessing per half-authenticated session', async () => {
    const user = await createActiveUser(env);
    await enableTotp(user.client, user.password);
    const attempt = await login(user.email, user.password);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await attempt.client.post('/api/v1/auth/login/mfa', { totpCode: String(100000 + i) }))
          .statusCode,
      );
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it('demands the second factor for step-up once TOTP is on', async () => {
    const user = await createActiveUser(env);
    const { secret } = await enableTotp(user.client, user.password);
    const withoutCode = await user.client.post('/api/v1/auth/reauth/password', {
      password: user.password,
    });
    expect(withoutCode.json()).toMatchObject({ code: 'INVALID_CODE' });
    await reauth(user.client, user.password, { totpCode: totpCode(secret, 1) });
  });
});

describe("'auth.totp_disable' and 'auth.recovery_codes_regenerate'", () => {
  it('regenerates codes (invalidating the old set) and can turn 2FA off', async () => {
    const user = await createActiveUser(env);
    const { secret, recoveryCodes } = await enableTotp(user.client, user.password);
    const regenerated = await user.client.post('/api/v1/auth/recovery-codes');
    expect(regenerated.statusCode).toBe(200);
    const fresh = regenerated.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(fresh.some((code) => recoveryCodes.includes(code))).toBe(false);

    const oldCode = await login(user.email, user.password);
    expect(
      (await oldCode.client.post('/api/v1/auth/login/mfa', { recoveryCode: recoveryCodes[0] }))
        .statusCode,
    ).toBe(400);

    await reauth(user.client, user.password, { totpCode: totpCode(secret, 1) });
    expect((await user.client.delete('/api/v1/auth/totp')).statusCode).toBe(200);
    expect((await login(user.email, user.password)).response.json()).toEqual({ stage: 'active' });
    expect(env.mailer.to(user.email).at(-1)?.subject).toContain('turned off');
  });
});

describe('passkeys', () => {
  async function passkeyOnlyUser() {
    const { email, username } = identity();
    const client = new TestClient(env.app);
    await client.post('/api/v1/accounts', {
      email,
      username,
      confirmsAdult: true,
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
    });
    await client.post('/api/v1/accounts/verify-email', { email, code: env.mailer.lastCode(email) });
    const authenticator = new SoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const options = await client.post('/api/v1/auth/passkeys/register/options');
    expect(options.statusCode, options.body).toBe(200);
    const { flowId, options: creation } = options.json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    expect(creation['authenticatorSelection']).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    const verify = await client.post('/api/v1/auth/passkeys/register/verify', {
      flowId,
      name: 'Laptop',
      response: authenticator.register(creation),
    });
    expect(verify.statusCode, verify.body).toBe(200);
    return { client, email, username, authenticator };
  }

  async function passkeyLogin(
    authenticator: SoftwareAuthenticator,
    client = new TestClient(env.app),
    overrides: { origin?: string; userVerified?: boolean } = {},
  ) {
    const options = await client.post('/api/v1/auth/passkeys/login/options', { purpose: 'login' });
    const { flowId, options: request } = options.json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    const assertion = authenticator.assert(request, overrides);
    const response = await client.post('/api/v1/auth/passkeys/login/verify', {
      flowId,
      response: assertion,
    });
    return { client, response, flowId, assertion };
  }

  it("creates a passwordless account ('auth.passkey_register_options', 'auth.passkey_register_verify')", async () => {
    const user = await passkeyOnlyUser();
    const me = meResponseSchema.parse((await user.client.get('/api/v1/accounts/me')).json());
    expect(me.status).toBe('active');
    expect(me.security).toMatchObject({ hasPassword: false, passkeyCount: 1 });
  });

  it("signs in with a passkey and updates the signature counter ('auth.passkey_login_options', 'auth.passkey_login_verify')", async () => {
    const user = await passkeyOnlyUser();
    const first = await passkeyLogin(user.authenticator);
    expect(first.response.json()).toEqual({ stage: 'active' });
    expect((await first.client.get('/api/v1/accounts/me')).statusCode).toBe(200);
    const row = await env.db
      .selectFrom('passkeys')
      .select(['sign_count', 'last_used_at'])
      .where('credential_id', '=', user.authenticator.credentialId)
      .executeTakeFirstOrThrow();
    expect(Number(row.sign_count)).toBe(1);
    expect(row.last_used_at).not.toBeNull();
  });

  it('rejects replayed challenges, foreign origins and assertions without user verification', async () => {
    const user = await passkeyOnlyUser();
    const ok = await passkeyLogin(user.authenticator);
    const replay = await ok.client.post('/api/v1/auth/passkeys/login/verify', {
      flowId: ok.flowId,
      response: ok.assertion,
    });
    expect(replay.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const phishing = await passkeyLogin(user.authenticator, new TestClient(env.app), {
      origin: 'https://tessera-login.example',
    });
    expect(phishing.response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(phishing.client.cookie).toBeUndefined();

    // Registered credential, but the assertion lacks the user-verification (UV) flag.
    const unverified = await passkeyLogin(user.authenticator, new TestClient(env.app), {
      userVerified: false,
    });
    expect(unverified.response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(unverified.client.cookie).toBeUndefined();
  });

  it("lists passkeys ('auth.passkeys_list'), re-authenticates ('auth.reauth_passkey') and protects the last credential ('auth.passkey_delete')", async () => {
    const user = await passkeyOnlyUser();
    const list = await user.client.get('/api/v1/auth/passkeys');
    const [passkey] = list.json<{ passkeys: { id: string; name: string; synced: boolean }[] }>()
      .passkeys;
    expect(passkey).toMatchObject({ name: 'Laptop', synced: true });

    await env.db
      .updateTable('sessions')
      .set({ reauthenticated_at: new Date(Date.now() - 11 * 60_000) })
      .execute();
    expect((await user.client.delete(`/api/v1/auth/passkeys/${passkey!.id}`)).json()).toMatchObject(
      { code: 'STEP_UP_REQUIRED' },
    );

    const options = await user.client.post('/api/v1/auth/passkeys/login/options', {
      purpose: 'reauth',
    });
    const { flowId, options: request } = options.json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    expect(request['allowCredentials']).toHaveLength(1);
    const reauthResponse = await user.client.post('/api/v1/auth/reauth/passkey', {
      flowId,
      response: user.authenticator.assert(request),
    });
    expect(reauthResponse.statusCode, reauthResponse.body).toBe(200);

    const last = await user.client.delete(`/api/v1/auth/passkeys/${passkey!.id}`);
    expect(last.json()).toMatchObject({ code: 'LAST_CREDENTIAL' });
  });

  it('does not let one user delete or re-authenticate with another user’s passkey', async () => {
    const alice = await passkeyOnlyUser();
    const mallory = await createActiveUser(env);
    const alicePasskey = (await alice.client.get('/api/v1/auth/passkeys')).json<{
      passkeys: { id: string }[];
    }>().passkeys[0]!;
    const deletion = await mallory.client.delete(`/api/v1/auth/passkeys/${alicePasskey.id}`);
    expect(deletion.json()).toMatchObject({ code: 'NOT_FOUND' });

    const options = await mallory.client.post('/api/v1/auth/passkeys/login/options', {
      purpose: 'reauth',
    });
    const { flowId, options: request } = options.json<{
      flowId: string;
      options: Record<string, unknown>;
    }>();
    const stolen = await mallory.client.post('/api/v1/auth/reauth/passkey', {
      flowId,
      response: alice.authenticator.assert(request),
    });
    expect(stolen.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

describe("'auth.password_reset_request' and 'auth.password_reset_complete'", () => {
  it('resets via emailed single-use token and signs out every session', async () => {
    const user = await createActiveUser(env);
    const anonymous = new TestClient(env.app);
    const request = await anonymous.post('/api/v1/auth/password-reset', { email: user.email });
    expect(request.statusCode).toBe(202);
    const token = env.mailer.lastResetToken(user.email);
    expect(env.mailer.to(user.email).at(-1)?.text).toContain(`${ORIGIN}/reset-password#token=`);

    const weak = await anonymous.post('/api/v1/auth/password-reset/complete', {
      token,
      password: 'password12345',
    });
    expect(weak.json()).toMatchObject({ code: 'WEAK_PASSWORD' });

    const done = await anonymous.post('/api/v1/auth/password-reset/complete', {
      token,
      password: NEW_PASSWORD,
    });
    expect(done.statusCode).toBe(200);
    expect((await user.client.get('/api/v1/accounts/me')).statusCode).toBe(401);
    const reuse = await anonymous.post('/api/v1/auth/password-reset/complete', {
      token,
      password: `${NEW_PASSWORD}x`,
    });
    expect(reuse.json()).toMatchObject({ code: 'INVALID_CODE' });
    expect((await login(user.email, NEW_PASSWORD)).response.statusCode).toBe(200);
  });

  it('answers unknown emails identically without sending anything', async () => {
    const email = identity().email;
    const response = await new TestClient(env.app).post('/api/v1/auth/password-reset', { email });
    expect(response.statusCode).toBe(202);
    expect(env.mailer.to(email)).toHaveLength(0);
  });

  it('still requires the second factor when 2FA is enabled', async () => {
    const user = await createActiveUser(env);
    const { secret } = await enableTotp(user.client, user.password);
    const anonymous = new TestClient(env.app);
    await anonymous.post('/api/v1/auth/password-reset', { email: user.email });
    const token = env.mailer.lastResetToken(user.email);
    const without = await anonymous.post('/api/v1/auth/password-reset/complete', {
      token,
      password: NEW_PASSWORD,
    });
    expect(without.json()).toMatchObject({ code: 'INVALID_CODE' });
    const withCode = await anonymous.post('/api/v1/auth/password-reset/complete', {
      token,
      password: NEW_PASSWORD,
      totpCode: totpCode(secret, 1),
    });
    expect(withCode.statusCode, withCode.body).toBe(200);
  });
});

describe("'auth.sessions_list', 'auth.session_revoke', 'auth.sessions_revoke_others', 'auth.logout'", () => {
  it('lists, revokes and logs out sessions', async () => {
    const user = await createActiveUser(env);
    const phone = await login(
      user.email,
      user.password,
      new TestClient(env.app, { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile' }),
    );
    const tablet = await login(user.email, user.password);

    const listed = sessionListSchema.parse(
      (await user.client.get('/api/v1/auth/sessions')).json(),
    ).sessions;
    expect(listed).toHaveLength(3);
    expect(listed.filter((s) => s.current)).toHaveLength(1);
    expect(listed.map((s) => s.userAgent)).toContain('Chrome on Android');

    const phoneId = sessionListSchema
      .parse((await phone.client.get('/api/v1/auth/sessions')).json())
      .sessions.find((s) => s.current)!.id;
    expect((await user.client.delete(`/api/v1/auth/sessions/${phoneId}`)).statusCode).toBe(200);
    expect((await phone.client.get('/api/v1/accounts/me')).statusCode).toBe(401);

    const others = await user.client.post('/api/v1/auth/sessions/revoke-others');
    expect(others.json()).toEqual({ revoked: 1 });
    expect((await tablet.client.get('/api/v1/accounts/me')).statusCode).toBe(401);

    const tokenBefore = user.client.cookie;
    expect((await user.client.post('/api/v1/auth/logout')).statusCode).toBe(200);
    expect(user.client.cookie).toBeUndefined();
    const replay = new TestClient(env.app);
    replay.cookie = tokenBefore;
    expect((await replay.get('/api/v1/accounts/me')).statusCode).toBe(401);
  });

  it("cannot revoke another user's session", async () => {
    const alice = await createActiveUser(env);
    const bob = await createActiveUser(env);
    const aliceSession = sessionListSchema.parse(
      (await alice.client.get('/api/v1/auth/sessions')).json(),
    ).sessions[0]!;
    expect(
      (await bob.client.delete(`/api/v1/auth/sessions/${aliceSession.id}`)).json(),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect((await alice.client.get('/api/v1/accounts/me')).statusCode).toBe(200);
  });

  it('expires sessions by idle time and absolute lifetime', async () => {
    const idle = await createActiveUser(env);
    await env.db
      .updateTable('sessions')
      .set({ idle_expires_at: new Date(Date.now() - 1000) })
      .where('revoked_at', 'is', null)
      .execute();
    expect((await idle.client.get('/api/v1/accounts/me')).statusCode).toBe(401);
    const absolute = await createActiveUser(env);
    await env.db
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('revoked_at', 'is', null)
      .execute();
    expect((await absolute.client.get('/api/v1/accounts/me')).statusCode).toBe(401);
  });

  it('ignores malformed and forged cookies', async () => {
    for (const cookie of ['', 'x', 'a'.repeat(500), 'forged-token-value-not-in-db']) {
      const client = new TestClient(env.app);
      client.cookie = cookie;
      expect((await client.get('/api/v1/accounts/me')).statusCode).toBe(401);
    }
  });
});

describe('audit log', () => {
  it('records credential changes in an intact hash chain and refuses edits', async () => {
    const user = await createActiveUser(env);
    await enableTotp(user.client, user.password);
    const actions = await env.db.selectFrom('audit_log').select('action').execute();
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'account.created',
        'account.email_verified',
        'auth.password_set',
        'account.activated',
        'auth.totp_enabled',
      ]),
    );
    expect(await env.modules.audit.verifyChain()).toBeNull();
    await expect(sql`UPDATE audit_log SET action = 'tampered'`.execute(env.db)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`DELETE FROM audit_log`.execute(env.db)).rejects.toThrow(/append-only/);
    for (const row of await env.db.selectFrom('audit_log').select('details').execute()) {
      expect(JSON.stringify(row.details)).not.toMatch(/password|secret|code/i);
    }
  });
});
