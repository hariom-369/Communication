import { randomBytes, type KeyObject } from 'node:crypto';

import type { AdminRole } from '@tessera/validation';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildAdminApp } from '../admin-app.js';
import { composeAdmin, type AdminModules } from '../admin-compose.js';
import { ADMIN_FLOW_COOKIE, ADMIN_SESSION_COOKIE } from '../platform/http/admin-routes.js';
import { ValkeyRateLimiter } from '../platform/rate-limit.js';

import { FakeIdp } from './fake-idp.js';
import type { IntegrationApp } from './integration-app.js';
import { SoftwareAuthenticator } from './webauthn-authenticator.js';

export const ADMIN_ORIGIN = 'https://admin.tessera.test';
export const ADMIN_RP_ID = 'admin.tessera.test';
/** A made-up security key model id, for allow-list tests. */
export const TEST_AAGUID = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');

export interface AdminTestEnv {
  readonly app: FastifyInstance;
  readonly idp: FakeIdp;
  readonly admin: AdminModules;
  close(): Promise<void>;
}

export async function startAdminApp(
  env: IntegrationApp,
  options: { aaguids?: string[]; attestationRoots?: string[]; idleMinutes?: number } = {},
): Promise<AdminTestEnv> {
  const idp = await FakeIdp.start();
  const admin = composeAdmin(
    {
      VALKEY_KEY_PREFIX: env.keyPrefix,
      ADMIN_ORIGINS: [ADMIN_ORIGIN],
      ADMIN_PUBLIC_URL: ADMIN_ORIGIN,
      ADMIN_OIDC_ISSUER: idp.issuer,
      ADMIN_OIDC_CLIENT_ID: idp.clientId,
      ADMIN_OIDC_CLIENT_SECRET: idp.clientSecret,
      ADMIN_EMAIL_DOMAINS: ['tessera.test'],
      ADMIN_OIDC_ALLOW_INSECURE: true,
      ADMIN_WEBAUTHN_RP_ID: ADMIN_RP_ID,
      ADMIN_AUTHENTICATOR_AAGUIDS: options.aaguids ?? [],
      ADMIN_SESSION_IDLE_MINUTES: options.idleMinutes ?? 30,
      ADMIN_SESSION_ABSOLUTE_HOURS: 8,
    },
    {
      db: env.db,
      valkey: env.valkey,
      logger: env.logger,
      media: env.media,
      attestationRoots: options.attestationRoots ?? [],
    },
    env.modules,
  );
  const app = await buildAdminApp({
    logger: env.logger,
    rateLimiter: new ValkeyRateLimiter(env.valkey, `rl-admin-${env.keyPrefix}`),
    allowedOrigins: [ADMIN_ORIGIN],
    trustProxyHops: 0,
    hsts: true,
    routes: admin.routes,
    sessions: admin.sessions,
    audit: env.modules.audit,
  });
  return {
    app,
    idp,
    admin,
    close: async () => {
      await app.close();
      await idp.close();
    },
  };
}

let ipCounter = 0;

/** A browser on the admin origin: keeps the admin session and sign-in flow cookies. */
export class AdminTestClient {
  readonly cookies = new Map<string, string>();
  readonly ip: string;

  constructor(
    readonly app: FastifyInstance,
    options: { origin?: string } = {},
  ) {
    ipCounter += 1;
    this.ip = `203.0.113.${String(ipCounter % 250)}`;
    this.origin = options.origin ?? ADMIN_ORIGIN;
  }

  readonly origin: string;

  async request(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {
      origin: this.origin,
      'sec-fetch-site': 'same-origin',
      'x-tessera-csrf': '1',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36',
    };
    if (this.cookies.size > 0)
      headers['cookie'] = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    for (const cookie of response.cookies) {
      if (cookie.name !== ADMIN_SESSION_COOKIE && cookie.name !== ADMIN_FLOW_COOKIE) continue;
      const expired =
        cookie.value === '' ||
        (cookie.expires !== undefined && cookie.expires.getTime() < Date.now());
      if (expired) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    return response;
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body: unknown = {}) => this.request('POST', url, body);
}

export function newKey(
  options: {
    hardwareBound?: boolean;
    aaguid?: Buffer;
    attestation?: { certificates: readonly Buffer[]; key: KeyObject } | 'self';
  } = {},
): SoftwareAuthenticator {
  return new SoftwareAuthenticator({
    rpId: ADMIN_RP_ID,
    origin: ADMIN_ORIGIN,
    ...(options.hardwareBound === false
      ? {}
      : { hardwareBound: { aaguid: options.aaguid ?? TEST_AAGUID } }),
    ...(options.attestation === undefined ? {} : { attestation: options.attestation }),
  });
}

/** The identity-provider step: returns the callback response. */
export async function oidcStep(
  admin: AdminTestEnv,
  client: AdminTestClient,
  identity: { subject: string; email: string; emailVerified?: boolean },
): Promise<LightMyRequestResponse> {
  admin.idp.identity = identity;
  const started = await client.post('/admin/v1/auth/oidc/start');
  if (started.statusCode !== 200) throw new Error(`start failed: ${started.body}`);
  const authorize = await fetch(started.json<{ authorizationUrl: string }>().authorizationUrl, {
    redirect: 'manual',
  });
  const location = new URL(authorize.headers.get('location') ?? 'http://invalid/');
  return client.post('/admin/v1/auth/oidc/callback', {
    code: location.searchParams.get('code') ?? 'none',
    state: location.searchParams.get('state') ?? 'none',
  });
}

/** Full sign-in (identity provider, then the security key: registered on first use). */
export async function signIn(
  admin: AdminTestEnv,
  client: AdminTestClient,
  identity: { subject: string; email: string },
  key: SoftwareAuthenticator,
): Promise<void> {
  const callback = await oidcStep(admin, client, identity);
  if (callback.statusCode !== 200) throw new Error(`callback failed: ${callback.body}`);
  const stage = callback.json<{ stage: string }>().stage;
  const options = await client.post('/admin/v1/auth/key/options');
  const { flowId, options: publicKey } = options.json<{
    flowId: string;
    options: Record<string, unknown>;
  }>();
  const response = stage === 'key_setup' ? key.register(publicKey) : key.assert(publicKey);
  const verified = await client.post('/admin/v1/auth/key/verify', {
    flowId,
    response,
    name: 'Test key',
  });
  if (verified.statusCode !== 200) throw new Error(`key failed: ${verified.body}`);
}

export async function stepUp(client: AdminTestClient, key: SoftwareAuthenticator): Promise<void> {
  const options = await client.post('/admin/v1/auth/reauth/options');
  const { flowId, options: publicKey } = options.json<{
    flowId: string;
    options: Record<string, unknown>;
  }>();
  const verified = await client.post('/admin/v1/auth/reauth/verify', {
    flowId,
    response: key.assert(publicKey),
  });
  if (verified.statusCode !== 200) throw new Error(`reauth failed: ${verified.body}`);
}

export interface TestAdmin {
  readonly id: string;
  readonly email: string;
  readonly client: AdminTestClient;
  readonly key: SoftwareAuthenticator;
}

/** An admin with the given roles (break-glass grants, as the operator command makes them). */
export async function makeAdmin(
  admin: AdminTestEnv,
  roles: AdminRole[],
  hours = 8,
): Promise<TestAdmin> {
  const email = `staff_${randomBytes(4).toString('hex')}@tessera.test`;
  const created = await admin.admin.directory.create({
    email,
    displayName: 'Test staff',
    createdBy: 'test',
  });
  for (const role of roles)
    await admin.admin.directory.grant({
      adminId: created.id,
      role,
      hours,
      grantedBy: 'test',
      approvalId: null,
    });
  const client = new AdminTestClient(admin.app);
  const key = newKey();
  await signIn(admin, client, { subject: `sub-${created.id}`, email }, key);
  return { id: created.id, email, client, key };
}
