import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { turnCredential } from './turn.js';

/**
 * The production coturn baseline (infra/calls/turnserver.conf) against a real coturn: relaying
 * into private, loopback, link-local (cloud metadata) and other internal ranges is refused, and
 * only fresh credentials minted with the shared secret are accepted (docs/calling.md §5).
 *
 * Needs the `turnserver` binary (CI installs coturn). Locally the suite is skipped without it.
 */

const CONFIG = fileURLToPath(
  new URL('../../../../../infra/calls/turnserver.conf', import.meta.url),
);
const SECRET = randomBytes(32).toString('hex');
const PORT = 34_000 + randomInt(1000);
const available = spawnSync('turnserver', ['--version']).status === 0;
/** IPv6 peers need an IPv6 relay allocation, so a host with IPv6 loopback. */
const ipv6 = existsSync('/proc/net/if_inet6');
if (!available && process.env['CI'] !== undefined)
  throw new Error('coturn (turnserver) must be installed in CI');

// ---- a minimal STUN/TURN client (RFC 5389 / RFC 5766), test-only -------------------------------

const COOKIE = 0x2112a442;
const ATTR = {
  username: 0x0006,
  integrity: 0x0008,
  errorCode: 0x0009,
  lifetime: 0x000d,
  peer: 0x0012,
  realm: 0x0014,
  nonce: 0x0015,
  relayed: 0x0016,
  transport: 0x0019,
  family: 0x0017,
} as const;

function attribute(type: number, value: Buffer): Buffer {
  const padded = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
  padded.writeUInt16BE(type, 0);
  padded.writeUInt16BE(value.length, 2);
  value.copy(padded, 4);
  return padded;
}

function xorAddress(ip: string, port: number, transaction: Buffer): Buffer {
  if (isIPv4(ip)) {
    const value = Buffer.alloc(8);
    value.writeUInt8(0x01, 1);
    value.writeUInt16BE(port ^ (COOKIE >>> 16), 2);
    const bytes = ip.split('.').map(Number);
    value.writeUInt32BE(
      (((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) ^ COOKIE) >>> 0,
      4,
    );
    return value;
  }
  const value = Buffer.alloc(20);
  value.writeUInt8(0x02, 1);
  value.writeUInt16BE(port ^ (COOKIE >>> 16), 2);
  const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), transaction]);
  const address = ipv6Bytes(ip);
  for (let i = 0; i < 16; i += 1) value[4 + i] = address[i]! ^ mask[i]!;
  return value;
}

function ipv6Bytes(ip: string): Buffer {
  const [head = '', tail = ''] = ip.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return Buffer.from(groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]));
}

interface Credentials {
  username: string;
  realm: string;
  nonce: string;
  key: Buffer;
}

function message(
  method: number,
  attributes: Buffer[],
  credentials?: Credentials,
  // IPv6 XOR-PEER-ADDRESS is masked with the transaction id, so the attribute and the header must
  // use the same one (a mismatch made the server decode a different, public address).
  transaction: Buffer = randomBytes(12),
): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(method, 0);
  header.writeUInt32BE(COOKIE, 4);
  transaction.copy(header, 8);
  let body = Buffer.concat(attributes);
  if (credentials !== undefined) {
    body = Buffer.concat([
      body,
      attribute(ATTR.username, Buffer.from(credentials.username)),
      attribute(ATTR.realm, Buffer.from(credentials.realm)),
      attribute(ATTR.nonce, Buffer.from(credentials.nonce)),
    ]);
    header.writeUInt16BE(body.length + 24, 2);
    const mac = createHmac('sha1', credentials.key)
      .update(Buffer.concat([header, body]))
      .digest();
    body = Buffer.concat([body, attribute(ATTR.integrity, mac)]);
  }
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

interface Response {
  type: number;
  attributes: Map<number, Buffer>;
  error: number | null;
}

function parse(packet: Buffer): Response {
  const attributes = new Map<number, Buffer>();
  let offset = 20;
  while (offset + 4 <= packet.length) {
    const type = packet.readUInt16BE(offset);
    const length = packet.readUInt16BE(offset + 2);
    attributes.set(type, packet.subarray(offset + 4, offset + 4 + length));
    offset += 4 + Math.ceil(length / 4) * 4;
  }
  const code = attributes.get(ATTR.errorCode);
  return {
    type: packet.readUInt16BE(0),
    attributes,
    error: code === undefined ? null : (code[2]! & 0x07) * 100 + code[3]!,
  };
}

class TurnClient {
  readonly #socket: Socket = createSocket('udp4');
  #credentials: Credentials | undefined;

  request(
    method: number,
    attributes: Buffer[],
    signed = true,
    transaction?: Buffer,
  ): Promise<Response> {
    const packet = message(method, attributes, signed ? this.#credentials : undefined, transaction);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('TURN request timed out'));
      }, 3000);
      this.#socket.once('message', (reply) => {
        clearTimeout(timer);
        resolve(parse(reply));
      });
      this.#socket.send(packet, PORT, '127.0.0.1');
    });
  }

  /** Allocate with the long-term credential mechanism: challenge first, then signed. */
  async allocate(username: string, password: string, family: 4 | 6 = 4): Promise<Response> {
    const transport = [attribute(ATTR.transport, Buffer.from([17, 0, 0, 0]))];
    if (family === 6) transport.push(attribute(ATTR.family, Buffer.from([2, 0, 0, 0])));
    const challenge = await this.request(0x0003, transport, false);
    expect(challenge.error).toBe(401);
    const realm = challenge.attributes.get(ATTR.realm)!.toString();
    this.#credentials = {
      username,
      realm,
      nonce: challenge.attributes.get(ATTR.nonce)!.toString(),
      key: createHash('md5').update(`${username}:${realm}:${password}`).digest(),
    };
    return this.request(0x0003, transport);
  }

  permit(ip: string): Promise<Response> {
    const transaction = randomBytes(12);
    return this.request(
      0x0008,
      [attribute(ATTR.peer, xorAddress(ip, 9, transaction))],
      true,
      transaction,
    );
  }

  close(): void {
    this.#socket.close();
  }
}

// ---- the tests ----------------------------------------------------------------------------------

let turnserver: ChildProcess | undefined;

beforeAll(async () => {
  if (!available) return;
  turnserver = spawn(
    'turnserver',
    [
      '-c',
      CONFIG,
      `--static-auth-secret=${SECRET}`,
      `--listening-port=${PORT}`,
      '--listening-ip=127.0.0.1',
      '--relay-ip=127.0.0.1',
      ...(ipv6 ? ['--relay-ip=::1'] : []),
      '--no-tls',
      '--no-dtls',
      '--log-file=stdout',
      '--pidfile=/dev/null',
    ],
    { stdio: 'ignore' },
  );
  // Wait until it answers a binding request.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = new TurnClient();
    try {
      await probe.request(0x0001, [], false);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      probe.close();
    }
  }
  throw new Error('coturn did not start');
});

afterAll(() => {
  turnserver?.kill('SIGTERM');
});

describe.skipIf(!available)('TURN relay policy (coturn baseline)', () => {
  it('accepts fresh credentials from the shared secret and refuses expired or forged ones', async () => {
    const fresh = turnCredential(SECRET, 600);
    const client = new TurnClient();
    const allocated = await client.allocate(fresh.username, fresh.credential);
    expect(allocated.error).toBeNull();
    expect(allocated.type).toBe(0x0103);
    expect(allocated.attributes.has(ATTR.relayed)).toBe(true);
    client.close();

    const expired = turnCredential(SECRET, -60);
    const late = new TurnClient();
    expect((await late.allocate(expired.username, expired.credential)).error).toBe(401);
    late.close();

    const forged = turnCredential(randomBytes(32).toString('hex'), 600);
    const mallory = new TurnClient();
    expect((await mallory.allocate(forged.username, forged.credential)).error).toBe(401);
    mallory.close();
  });

  it('refuses to relay into private, loopback, metadata and other internal ranges', async () => {
    const credential = turnCredential(SECRET, 600);
    const client = new TurnClient();
    expect((await client.allocate(credential.username, credential.credential)).error).toBeNull();
    const denied = [
      '10.0.0.5', // RFC 1918 (our VPC)
      '172.20.1.1',
      '192.168.1.1',
      '127.0.0.1', // the TURN host itself
      '169.254.169.254', // cloud metadata service
      '100.64.0.1', // carrier-grade NAT
      '0.0.0.0',
      '224.0.0.1', // multicast
    ];
    for (const ip of denied) {
      const response = await client.permit(ip);
      expect({ ip, error: response.error }).toEqual({ ip, error: 403 });
    }
    // A public peer is allowed (CreatePermission sends no traffic to it).
    expect((await client.permit('8.8.8.8')).error).toBeNull();
    client.close();
  });

  it.skipIf(!ipv6)('refuses the same for IPv6 peers', async () => {
    const credential = turnCredential(SECRET, 600);
    const client = new TurnClient();
    expect((await client.allocate(credential.username, credential.credential, 6)).error).toBeNull();
    const denied = [
      '::1',
      '::', // unspecified (reaches the host itself on Linux)
      '::ffff:10.0.0.5', // IPv4-mapped IPv6
      '64:ff9b::a00:5', // NAT64 of 10.0.0.5
      'fd00::1', // unique local
      'fe80::1', // link-local
      'ff02::1', // multicast
    ];
    for (const ip of denied) {
      const response = await client.permit(ip);
      expect({ ip, error: response.error }).toEqual({ ip, error: 403 });
    }
    expect((await client.permit('2001:4860:4860::8888')).error).toBeNull();
    client.close();
  });
});
