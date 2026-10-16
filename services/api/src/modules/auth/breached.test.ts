import { createHash } from 'node:crypto';

import { createLogger } from '@tessera/platform';
import { MemoryDestination } from '@tessera/platform/testing';
import { describe, expect, it, vi } from 'vitest';

import { RangeApiBreachedPasswords } from './breached.js';

const sha1 = (value: string) =>
  createHash('sha1').update(value, 'utf8').digest('hex').toUpperCase();

function checker(respond: (url: string) => Response | Promise<Response>) {
  const destination = new MemoryDestination();
  // The checker always passes the URL as a string.
  const fetchMock = vi.fn((input: string) => Promise.resolve(respond(input)));
  const breached = new RangeApiBreachedPasswords({
    baseUrl: 'https://pwned.internal/',
    logger: createLogger({ service: 'test', level: 'info', errorDetails: false, destination }),
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { breached, fetchMock, destination };
}

describe('breached-password check (range API mirror)', () => {
  it('sends only the five-character prefix and matches the suffix locally', async () => {
    const hash = sha1('correct horse battery staple');
    const { breached, fetchMock } = checker(
      () => new Response(`0000000000000000000000000000000000A:3\r\n${hash.slice(5)}:12\r\n`),
    );
    expect(await breached.isBreached('correct horse battery staple')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://pwned.internal/range/${hash.slice(0, 5)}`,
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain(hash.slice(5));
  });

  it('is not fooled by other suffixes or padding entries', async () => {
    const hash = sha1('a password nobody leaked 81!');
    const { breached } = checker(() => new Response(`${'F'.repeat(35)}:40\n${hash.slice(5)}:0\n`));
    expect(await breached.isBreached('a password nobody leaked 81!')).toBe(false);
  });

  it('fails open (and says so in the log) when the mirror cannot answer', async () => {
    const { breached, destination } = checker(() => new Response('', { status: 503 }));
    expect(await breached.isBreached('anything')).toBe(false);
    expect(destination.lines.some((line) => line.includes('auth.breach_check_unavailable'))).toBe(
      true,
    );
  });
});
