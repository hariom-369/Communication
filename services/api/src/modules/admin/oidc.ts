import { AppError } from '@tessera/platform';
import type { Redis } from 'ioredis';
import * as client from 'openid-client';
import { z } from 'zod';

import { randomToken } from '../../platform/secrets.js';

/**
 * Staff sign-in with the corporate identity provider (docs/admin.md §1, ADR-050): OpenID Connect
 * authorization code flow with PKCE, state and nonce, through the certified `openid-client`
 * library (discovery, JWKS, ID-token validation). The flow's secrets stay on the server, keyed by
 * a single-use flow id held in a strict cookie, so a callback only completes in the browser that
 * started it.
 */

export interface AdminOidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The admin SPA's callback page. */
  readonly redirectUri: string;
  /** Email domains that may sign in. */
  readonly emailDomains: readonly string[];
  /** Local and E2E tests only (refused in production by configuration validation). */
  readonly allowInsecure: boolean;
}

export interface OidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
}

const FLOW_TTL_SECONDS = 600;
const flowSchema = z.object({ state: z.string(), nonce: z.string(), verifier: z.string() });

export class AdminOidc {
  readonly #config: AdminOidcConfig;
  readonly #valkey: Redis;
  readonly #prefix: string;
  #discovered: Promise<client.Configuration> | null = null;

  constructor(config: AdminOidcConfig, valkey: Redis, keyPrefix: string) {
    this.#config = config;
    this.#valkey = valkey;
    this.#prefix = `${keyPrefix}:admin:oidc`;
  }

  #configuration(): Promise<client.Configuration> {
    this.#discovered ??= client
      .discovery(
        new URL(this.#config.issuer),
        this.#config.clientId,
        this.#config.clientSecret,
        undefined,
        this.#config.allowInsecure
          ? // eslint-disable-next-line @typescript-eslint/no-deprecated -- local/E2E identity provider over http; refused in production by config
            { execute: [client.allowInsecureRequests] }
          : undefined,
      )
      .catch((error: unknown) => {
        // Not cached: the next sign-in tries discovery again.
        this.#discovered = null;
        throw error;
      });
    return this.#discovered;
  }

  /** Starts a sign-in: the URL to send the browser to, and the flow id for the cookie. */
  async start(): Promise<{ url: string; flowId: string }> {
    let configuration: client.Configuration;
    try {
      configuration = await this.#configuration();
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'The identity provider cannot be reached.',
      });
    }
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.#config.redirectUri,
      scope: 'openid email profile',
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    const flowId = randomToken(24);
    await this.#valkey.set(
      `${this.#prefix}:${flowId}`,
      JSON.stringify({ state, nonce, verifier }),
      'EX',
      FLOW_TTL_SECONDS,
    );
    return { url: url.href, flowId };
  }

  /** Completes the flow (single use) and returns the verified identity. */
  async finish(flowId: string | undefined, code: string, state: string): Promise<OidcIdentity> {
    if (flowId === undefined || !/^[A-Za-z0-9_-]{32}$/.test(flowId))
      throw new AppError('INVALID_CREDENTIALS');
    const raw = await this.#valkey.getdel(`${this.#prefix}:${flowId}`);
    const flow = raw === null ? null : flowSchema.safeParse(JSON.parse(raw));
    if (flow?.success !== true) throw new AppError('INVALID_CREDENTIALS');
    const configuration = await this.#configuration();
    const callback = new URL(this.#config.redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', state);
    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(configuration, callback, {
        pkceCodeVerifier: flow.data.verifier,
        expectedState: flow.data.state,
        expectedNonce: flow.data.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch {
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (claims === undefined) throw new AppError('INVALID_CREDENTIALS');
    const email = typeof claims['email'] === 'string' ? claims['email'].toLowerCase() : '';
    if (claims['email_verified'] !== true || email === '')
      throw new AppError('FORBIDDEN', { detail: 'Your account has no verified email address.' });
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!this.#config.emailDomains.includes(domain))
      throw new AppError('FORBIDDEN', { detail: 'This account cannot use the admin console.' });
    return { issuer: claims.iss, subject: claims.sub, email };
  }
}
