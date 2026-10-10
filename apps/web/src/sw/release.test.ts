import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { embeddedRelease, ReleaseShell, type ReleaseCore } from './release.js';

/**
 * The pinned shell's rules (ADR-052) against an in-memory Cache Storage, with Node's Ed25519 and
 * SHA-256 standing in for the crypto core's (the same algorithms; the Rust side has its own tests).
 */

const CONTEXT = 'tessera web release manifest v1\n';

class MemoryCache {
  readonly entries = new Map<string, Response>();
  match(path: string): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(path)?.clone());
  }
  put(path: string, response: Response): Promise<void> {
    this.entries.set(path, response);
    return Promise.resolve();
  }
}

class MemoryCaches {
  readonly stores = new Map<string, MemoryCache>();
  open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name);
    if (cache === undefined) {
      cache = new MemoryCache();
      this.stores.set(name, cache);
    }
    return Promise.resolve(cache);
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()]);
  }
  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name));
  }
}

const core: ReleaseCore = {
  verifyRelease: (manifest, signature, keys) =>
    (JSON.parse(keys) as string[]).some((key) => {
      const publicKey = {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(key, 'base64').toString('base64url'),
      };
      return verify(
        null,
        Buffer.concat([Buffer.from(CONTEXT), Buffer.from(manifest)]),
        { key: publicKey, format: 'jwk' },
        Buffer.from(signature, 'base64'),
      );
    }),
  releaseDigest: (file) => createHash('sha256').update(file).digest('base64'),
};

function keyPair(): { privateKey: KeyObject; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('base64'),
  };
}

interface Built {
  readonly files: Map<string, string>;
  readonly manifest: string;
  readonly signature: string;
}

function build(
  sequence: number,
  signer: { privateKey: KeyObject; publicKey: string },
  options: { keys?: string[]; files?: Record<string, string> } = {},
): Built {
  const files = new Map(
    Object.entries(
      options.files ?? {
        '/index.html': `<html>release ${String(sequence)}</html>`,
        '/assets/app.js': `console.log(${String(sequence)})`,
        '/assets/app.js.map': '{}',
      },
    ),
  );
  const digests = Object.fromEntries(
    [...files].map(([path, body]) => [path, createHash('sha256').update(body).digest('base64')]),
  );
  const manifest = JSON.stringify({
    v: 1,
    sequence,
    version: 'test',
    official: false,
    keys: options.keys ?? [signer.publicKey],
    files: digests,
  });
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(CONTEXT), Buffer.from(manifest)]),
    signer.privateKey,
  ).toString('base64');
  return { files, manifest, signature };
}

function serve(built: Built, tamper: Record<string, string> = {}) {
  return (path: string): Promise<Response> => {
    if (path === '/release.json') return Promise.resolve(new Response(built.manifest));
    if (path === '/release.json.sig') return Promise.resolve(new Response(built.signature));
    const body = tamper[path] ?? built.files.get(path);
    return Promise.resolve(
      body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(body, { headers: { 'content-security-policy': "default-src 'none'" } }),
    );
  };
}

function shell(
  caches: MemoryCaches,
  built: Built,
  embedded: { keys: string[]; sequence: number } | null,
  tamper: Record<string, string> = {},
): ReleaseShell {
  return new ReleaseShell({
    fetch: serve(built, tamper),
    caches: caches as unknown as CacheStorage,
    core: () => Promise.resolve(core),
    embedded,
  });
}

const ORIGIN = 'https://app.tessera.test';
const page = { url: `${ORIGIN}/chats/123`, method: 'GET', mode: 'navigate' };
const asset = (path: string) => ({ url: `${ORIGIN}${path}`, method: 'GET', mode: 'cors' });

async function installed(
  caches: MemoryCaches,
  built: Built,
  embedded: { keys: string[]; sequence: number },
) {
  const worker = shell(caches, built, embedded);
  await worker.install();
  await worker.activate();
  return worker;
}

describe('pinned app shell', () => {
  it('installs a verified release and answers the page and its files from it', async () => {
    const key = keyPair();
    const caches = new MemoryCaches();
    const release = build(1, key);
    const worker = await installed(caches, release, { keys: [key.publicKey], sequence: 1 });
    const html = await worker.respond(page, ORIGIN);
    expect(await html?.text()).toBe('<html>release 1</html>');
    // Headers (the CSP) are kept with the verified copy.
    expect(html?.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(await (await worker.respond(asset('/assets/app.js'), ORIGIN))?.text()).toBe(
      'console.log(1)',
    );
    // The API, realtime and anything not in the release go to the network.
    expect(await worker.respond(asset('/api/v1/accounts/me'), ORIGIN)).toBeNull();
    expect(await worker.respond(asset('/assets/other.js'), ORIGIN)).toBeNull();
    expect(await worker.respond(asset('/assets/app.js.map'), ORIGIN)).toBeNull();
    expect(await worker.respond({ ...page, url: 'https://elsewhere.test/' }, ORIGIN)).toBeNull();
    expect(await worker.respond({ ...page, method: 'POST' }, ORIGIN)).toBeNull();
  });

  it('refuses a manifest not signed by a trusted key, and keeps the running release', async () => {
    const key = keyPair();
    const attacker = keyPair();
    const caches = new MemoryCaches();
    const worker = await installed(caches, build(1, key), { keys: [key.publicKey], sequence: 1 });
    // A new worker whose manifest is signed by another key (even one it embeds itself).
    const forged = build(2, attacker);
    const next = shell(caches, forged, { keys: [attacker.publicKey], sequence: 2 });
    await expect(next.install()).rejects.toThrow(/signature/);
    expect(await (await worker.respond(page, ORIGIN))?.text()).toBe('<html>release 1</html>');
  });

  it('refuses tampered files, rollbacks and a manifest from another release', async () => {
    const key = keyPair();
    const caches = new MemoryCaches();
    await installed(caches, build(5, key), { keys: [key.publicKey], sequence: 5 });
    const six = build(6, key);
    await expect(
      shell(
        caches,
        six,
        { keys: [key.publicKey], sequence: 6 },
        { '/assets/app.js': 'evil()' },
      ).install(),
    ).rejects.toThrow(/does not match/);
    await expect(
      shell(caches, build(4, key), { keys: [key.publicKey], sequence: 4 }).install(),
    ).rejects.toThrow(/older release/);
    await expect(
      shell(caches, six, { keys: [key.publicKey], sequence: 7 }).install(),
    ).rejects.toThrow(/does not belong/);
    // A listed file that cannot be fetched.
    const missing = build(8, key);
    missing.files.delete('/assets/app.js');
    await expect(
      shell(caches, missing, { keys: [key.publicKey], sequence: 8 }).install(),
    ).rejects.toThrow(/unavailable/);
    // Failed installations leave nothing behind; the running copy is untouched.
    expect(
      [...caches.stores.keys()].filter((name) => name.startsWith('tessera-shell-')),
    ).toHaveLength(1);
  });

  it('a release can hand trust to the next key; old caches are dropped', async () => {
    const first = keyPair();
    const second = keyPair();
    const caches = new MemoryCaches();
    await installed(caches, build(1, first, { keys: [first.publicKey, second.publicKey] }), {
      keys: [first.publicKey],
      sequence: 1,
    });
    const worker = await installed(caches, build(2, second), {
      keys: [second.publicKey],
      sequence: 2,
    });
    expect(await (await worker.respond(page, ORIGIN))?.text()).toBe('<html>release 2</html>');
    const shells = [...caches.stores.keys()].filter((name) => name.startsWith('tessera-shell-'));
    expect(shells).toHaveLength(1);
    expect(shells[0]).toMatch(/^tessera-shell-2-/);
    // The first key is no longer trusted once release 2 named only its successor.
    await expect(
      shell(caches, build(3, first), { keys: [first.publicKey], sequence: 3 }).install(),
    ).rejects.toThrow(/signature/);
  });

  it('development builds (no embedded keys) do not pin', async () => {
    const caches = new MemoryCaches();
    const worker = shell(caches, build(1, keyPair()), null);
    await worker.install();
    await worker.activate();
    expect(worker.enabled).toBe(false);
    expect(await worker.respond(page, ORIGIN)).toBeNull();
    expect(embeddedRelease('__TESSERA_RELEASE_KEYS__', '__TESSERA_RELEASE_SEQUENCE__')).toBeNull();
    expect(embeddedRelease('["a"]', 3)).toEqual({ keys: ['a'], sequence: 3 });
    expect(embeddedRelease('[]', 3)).toBeNull();
  });
});
