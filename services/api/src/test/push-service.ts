import { createECDH, createPublicKey, randomBytes, verify, type ECDH } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createRequire } from 'node:module';

/**
 * A stand-in push service (RFC 8030) for tests: it accepts pushes like FCM or Mozilla's autopush
 * would, and lets the test decrypt them as the browser would (RFC 8291, with `http_ece` — the
 * library `web-push` itself uses) and check the VAPID signature (RFC 8292).
 */

const require = createRequire(import.meta.url);
const ece = require('http_ece') as {
  decrypt(
    buffer: Buffer,
    params: { version: 'aes128gcm'; privateKey: ECDH; authSecret: string },
  ): Buffer;
};

export interface ReceivedPush {
  readonly token: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface TestSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly token: string;
  readonly ecdh: ECDH;
}

export class FakePushService {
  readonly received: ReceivedPush[] = [];
  /** Status to answer per subscription token (default 201). */
  readonly statuses = new Map<string, number>();
  readonly #server: Server;
  readonly origin: string;

  private constructor(server: Server, origin: string) {
    this.#server = server;
    this.origin = origin;
  }

  static async start(): Promise<FakePushService> {
    const holder: { service?: FakePushService } = {};
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const token = (request.url ?? '').replace(/^\/push\//, '');
        holder.service?.received.push({
          token,
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        response.statusCode = holder.service?.statuses.get(token) ?? 201;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const service = new FakePushService(server, `http://127.0.0.1:${address.port}`);
    holder.service = service;
    return service;
  }

  /** A browser-side subscription (its private key stays here, like in the browser). */
  subscription(): TestSubscription {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const token = randomBytes(12).toString('hex');
    return {
      endpoint: `${this.origin}/push/${token}`,
      keys: {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
      token,
      ecdh,
    };
  }

  pushesFor(subscription: TestSubscription): ReceivedPush[] {
    return this.received.filter((push) => push.token === subscription.token);
  }

  /** Decrypts like the browser does; throws if the payload was not encrypted to `subscription`. */
  static decrypt(push: ReceivedPush, subscription: TestSubscription): string {
    return ece
      .decrypt(push.body, {
        version: 'aes128gcm',
        privateKey: subscription.ecdh,
        authSecret: subscription.keys.auth,
      })
      .toString('utf8');
  }

  /** Verifies the VAPID JWT (ES256) against `publicKey`; returns its claims. */
  static vapidClaims(push: ReceivedPush, publicKey: string): Record<string, unknown> {
    const header = push.headers.authorization ?? '';
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    if (match?.[1] === undefined || match[2] === undefined) throw new Error('no VAPID header');
    if (match[2] !== publicKey) throw new Error('VAPID key mismatch');
    const [head, claims, signature] = match[1].split('.');
    if (head === undefined || claims === undefined || signature === undefined)
      throw new Error('malformed JWT');
    const point = Buffer.from(publicKey, 'base64url');
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    const valid = verify(
      'sha256',
      Buffer.from(`${head}.${claims}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    if (!valid) throw new Error('VAPID signature invalid');
    return JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }
}
