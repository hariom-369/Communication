import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

/**
 * A minimal OpenID Connect provider for tests (integration and E2E): discovery, authorization
 * code with PKCE (S256), token endpoint with client_secret_basic/post, ES256-signed ID tokens,
 * JWKS. The "signed-in user" is set by the test (or, with none set, typed into a sign-in page
 * by the browser, for E2E); `misbehave` lets a test make the provider lie
 * (wrong nonce, audience, issuer, unverified email) to check the client refuses it.
 */

export interface IdpIdentity {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified?: boolean;
}

export type Misbehaviour = 'wrong_nonce' | 'wrong_audience' | 'wrong_issuer' | 'expired' | null;

interface PendingCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string;
  readonly identity: IdpIdentity;
}

export class FakeIdp {
  readonly clientId = 'tessera-admin';
  readonly clientSecret: string;
  readonly server: Server;
  readonly issuer: string;
  identity: IdpIdentity | null = null;
  misbehave: Misbehaviour = null;
  readonly #codes = new Map<string, PendingCode>();

  readonly #key: CryptoKey;
  readonly #jwk: JWK;

  // No parameter properties: the E2E runner loads this file with Node's type stripping.
  private constructor(server: Server, issuer: string, key: CryptoKey, jwk: JWK, secret: string) {
    this.server = server;
    this.issuer = issuer;
    this.#key = key;
    this.#jwk = jwk;
    this.clientSecret = secret;
  }

  static async start(port = 0, clientSecret?: string): Promise<FakeIdp> {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-1', alg: 'ES256', use: 'sig' };
    const holder: { idp?: FakeIdp } = {};
    const server = createServer((request, response) => {
      void holder.idp?.handle(request).then(
        ({ status, headers, body }) => {
          response.writeHead(status, headers);
          response.end(body);
        },
        () => {
          response.writeHead(500);
          response.end();
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const idp = new FakeIdp(
      server,
      `http://127.0.0.1:${String(address.port)}`,
      privateKey,
      jwk,
      clientSecret ?? randomBytes(24).toString('base64url'),
    );
    holder.idp = idp;
    return idp;
  }

  close(): Promise<void> {
    return new Promise((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  async handle(
    request: IncomingMessage,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const url = new URL(request.url ?? '/', this.issuer);
    const json = (status: number, value: unknown) => ({
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(value),
    });
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    if (url.pathname === '/jwks') return json(200, { keys: [this.#jwk] });
    if (url.pathname === '/authorize') {
      // A browser posts the sign-in form back with the original parameters.
      const params =
        request.method === 'POST' ? new URLSearchParams(await readBody(request)) : url.searchParams;
      if (
        params.get('client_id') !== this.clientId ||
        params.get('response_type') !== 'code' ||
        params.get('code_challenge_method') !== 'S256'
      )
        return json(400, { error: 'invalid_request' });
      const typed = params.get('login_email');
      const identity: IdpIdentity | null =
        typed !== null
          ? {
              email: typed,
              subject: params.get('login_subject') ?? `sub-${typed}`,
              emailVerified: true,
            }
          : this.identity;
      // No preset identity (E2E): show a sign-in page, as a real identity provider would.
      if (identity === null) return loginPage(params);
      const code = randomBytes(16).toString('base64url');
      this.#codes.set(code, {
        clientId: this.clientId,
        redirectUri: params.get('redirect_uri') ?? '',
        challenge: params.get('code_challenge') ?? '',
        nonce: params.get('nonce') ?? '',
        identity,
      });
      const target = new URL(params.get('redirect_uri') ?? '');
      target.searchParams.set('code', code);
      target.searchParams.set('state', params.get('state') ?? '');
      return { status: 302, headers: { location: target.href }, body: '' };
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(await readBody(request));
      const basic = request.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(request.headers.authorization.slice(6), 'base64')
            .toString()
            .split(':')
            .map(decodeURIComponent)
        : null;
      const clientId = basic?.[0] ?? form.get('client_id');
      const secret = basic?.[1] ?? form.get('client_secret');
      if (clientId !== this.clientId || secret !== this.clientSecret)
        return json(401, { error: 'invalid_client' });
      const pending = this.#codes.get(form.get('code') ?? '');
      this.#codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (
        pending === undefined ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('redirect_uri') !== pending.redirectUri ||
        createHash('sha256').update(verifier).digest('base64url') !== pending.challenge
      )
        return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        email: pending.identity.email,
        email_verified: pending.identity.emailVerified ?? true,
        nonce: this.misbehave === 'wrong_nonce' ? 'not-the-nonce' : pending.nonce,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'test-1' })
        .setIssuer(this.misbehave === 'wrong_issuer' ? 'https://evil.example' : this.issuer)
        .setSubject(pending.identity.subject)
        .setAudience(this.misbehave === 'wrong_audience' ? 'someone-else' : this.clientId)
        .setIssuedAt(now - (this.misbehave === 'expired' ? 7200 : 0))
        .setExpirationTime(now + (this.misbehave === 'expired' ? -3600 : 300))
        .sign(this.#key);
      return json(200, {
        access_token: randomBytes(16).toString('base64url'),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      });
    }
    return json(404, { error: 'not_found' });
  }
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

function loginPage(params: URLSearchParams): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  const hidden = [...params]
    .filter(([name]) => !name.startsWith('login_'))
    .map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`)
    .join('');
  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; form-action *",
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test identity provider</title></head><body><main><h1>Test identity provider</h1><form method="post" action="/authorize">${hidden}<label>Work email <input name="login_email" type="email" required></label><button type="submit">Continue</button></form></main></body></html>`,
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (data += chunk));
    request.on('end', () => {
      resolve(data);
    });
    request.on('error', reject);
  });
}
