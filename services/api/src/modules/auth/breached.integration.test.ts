import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { CURRENT_TERMS_VERSION } from '@tessera/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  identity,
  startIntegrationApp,
  STRONG_PASSWORD,
  TestClient,
  type IntegrationApp,
} from '../../test/integration-app.js';

/**
 * New passwords are checked against breached passwords through a mirror of the range API
 * (docs/authentication.md §2.1). The mirror here knows one password; it records which prefixes
 * it is asked for, so the test also shows the full hash never leaves the API.
 */
const BREACHED = 'Tr0ub4dour&3-but-leaked-in-2019'; // gitleaks:allow (test fixture)
const sha1 = (value: string) =>
  createHash('sha1').update(value, 'utf8').digest('hex').toUpperCase();

let env: IntegrationApp;
let mirror: http.Server;
const asked: string[] = [];

beforeAll(async () => {
  const hash = sha1(BREACHED);
  mirror = http.createServer((request, response) => {
    asked.push(request.url ?? '');
    const prefix = /^\/range\/([0-9A-F]{5})$/.exec(request.url ?? '')?.[1];
    if (prefix === undefined) {
      response.writeHead(404).end();
      return;
    }
    const lines = [`${'0'.repeat(35)}:2`];
    if (prefix === hash.slice(0, 5)) lines.push(`${hash.slice(5)}:4711`);
    response.writeHead(200, { 'content-type': 'text/plain' }).end(lines.join('\r\n'));
  });
  await new Promise<void>((resolve) => mirror.listen(0, '127.0.0.1', resolve));
  const { port } = mirror.address() as AddressInfo;
  env = await startIntegrationApp({ pwnedPasswordsUrl: `http://127.0.0.1:${String(port)}` });
});
afterAll(async () => {
  await env.close();
  await new Promise((resolve) => mirror.close(resolve));
});

async function verifiedClient(): Promise<TestClient> {
  const { email, username } = identity();
  const client = new TestClient(env.app);
  const signup = await client.post('/api/v1/accounts', {
    email,
    username,
    confirmsAdult: true,
    acceptedTermsVersion: CURRENT_TERMS_VERSION,
  });
  expect(signup.statusCode, signup.body).toBe(202);
  const verify = await client.post('/api/v1/accounts/verify-email', {
    email,
    code: env.mailer.lastCode(email),
  });
  expect(verify.statusCode, verify.body).toBe(200);
  return client;
}

describe('breached-password check', () => {
  it('refuses a password from a breach, accepts an unbreached one, and sends only a prefix', async () => {
    const client = await verifiedClient();
    const refused = await client.post('/api/v1/auth/password/initial', { password: BREACHED });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ code: string; detail: string }>()).toMatchObject({
      code: 'WEAK_PASSWORD',
      detail: expect.stringContaining('data breach') as string,
    });
    const accepted = await client.post('/api/v1/auth/password/initial', {
      password: STRONG_PASSWORD,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(asked).toEqual([
      `/range/${sha1(BREACHED).slice(0, 5)}`,
      `/range/${sha1(STRONG_PASSWORD).slice(0, 5)}`,
    ]);
  });
});
