import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { hostsIn, hostVariants, LinkSafety } from './link-safety.js';

const digest = (host: string) => createHash('sha256').update(host).digest();

function api(blocked: string[]) {
  const prefixes = Buffer.concat(blocked.map((host) => digest(host).subarray(0, 4)));
  return {
    linkPrefixes: vi.fn(() => Promise.resolve({ prefixes: prefixes.toString('base64') })),
    linkHashes: vi.fn((prefix: string) =>
      Promise.resolve({
        hashes: blocked
          .filter((host) => digest(host).subarray(0, 4).toString('hex') === prefix)
          .map((host) => ({ sha256: digest(host).toString('hex'), category: 'phishing' })),
      }),
    ),
  };
}

describe('harmful-link checks on the device', () => {
  it('finds hosts the same way the server does', () => {
    expect(hostsIn('see https://WWW.Bad.Example./x and good.org/page, not 3.14').sort()).toEqual([
      'bad.example',
      'good.org',
    ]);
    expect(hostVariants('a.b.bad.example')).toEqual([
      'a.b.bad.example',
      'b.bad.example',
      'bad.example',
    ]);
  });

  it('flags blocklisted hosts and subdomains, asking only for matching prefixes', async () => {
    const fake = api(['bad.example']);
    const safety = new LinkSafety(fake);
    expect(await safety.harmfulHosts('login at https://secure.bad.example/now')).toEqual([
      'secure.bad.example',
    ]);
    expect(await safety.harmfulHosts('fine: https://good.org')).toEqual([]);
    // Only the matching prefix was looked up, never the host or URL.
    expect(fake.linkHashes).toHaveBeenCalledTimes(1);
    expect(fake.linkHashes).toHaveBeenCalledWith(
      digest('bad.example').subarray(0, 4).toString('hex'),
    );
    // Prefixes are fetched once and reused.
    expect(fake.linkPrefixes).toHaveBeenCalledTimes(1);
    expect(await safety.harmfulHosts('no links at all')).toEqual([]);
  });

  it('stays quiet (and retries later) when the list cannot be loaded', async () => {
    const fake = {
      linkPrefixes: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ prefixes: digest('bad.example').subarray(0, 4).toString('base64') }),
      linkHashes: api(['bad.example']).linkHashes,
    };
    const safety = new LinkSafety(fake);
    expect(await safety.harmfulHosts('https://bad.example')).toEqual([]);
    expect(await safety.harmfulHosts('https://bad.example')).toEqual(['bad.example']);
  });
});
