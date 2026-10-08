import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchLinkPreview,
  isPublicAddress,
  parseHeadMetadata,
  parsePreviewUrl,
  SafeFetchError,
  type SafeFetchTransport,
} from './index.js';
import { MAX_BYTES, USER_AGENT } from './fetcher.js';

/** SSRF suite for the link-preview fetcher (docs/security.md §6). */

function response(
  status: number,
  headers: Record<string, string>,
  body: string | Buffer[] = '',
): IncomingMessage {
  const stream = Readable.from(typeof body === 'string' ? [Buffer.from(body)] : body);
  return Object.assign(stream, { statusCode: status, headers }) as unknown as IncomingMessage;
}

const html = (head: string) =>
  `<!doctype html><html><head>${head}</head><body>secret</body></html>`;

function transport(
  dns: Record<string, string[]>,
  pages: Record<string, () => IncomingMessage>,
): SafeFetchTransport & { calls: { url: string; address: string; headers: object }[] } {
  const calls: { url: string; address: string; headers: object }[] = [];
  return {
    calls,
    resolve: (hostname) => {
      const found = dns[hostname];
      return found === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(found);
    },
    get: (url, address, headers) => {
      calls.push({ url: url.href, address, headers });
      const page = pages[url.href];
      return page === undefined
        ? Promise.reject(new Error('ECONNREFUSED'))
        : Promise.resolve(page());
    },
  };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof SafeFetchError ? error.reason : 'other';
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('address policy', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.1',
    '::',
    '::1',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    '0:0:0:0:0:ffff:a00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::10.0.0.1',
    '2002:7f00:1::1',
    '2001:db8::1',
    '2001::1',
    '127.1',
    'localhost',
    '',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '64:ff9b::808:808'])(
    'allows %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('URL rules', () => {
  it.each([
    'http://example.com/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'gopher://example.com/',
    'https://example.com:8443/',
    'https://user:pass@example.com/',
    'not a url',
    `https://example.com/${'a'.repeat(2100)}`,
  ])('rejects %s', (url) => {
    expect(() => parsePreviewUrl(url)).toThrow(SafeFetchError);
  });

  it('accepts https on 443 and drops the fragment', () => {
    expect(parsePreviewUrl(' https://Example.com:443/a?b=1#frag ').href).toBe(
      'https://example.com/a?b=1',
    );
  });
});

describe('fetching', () => {
  it('connects only to the checked address, with no cookies and a fixed User-Agent', async () => {
    const t = transport(
      { 'news.example': ['93.184.216.34'] },
      {
        'https://news.example/story': () =>
          response(
            200,
            { 'content-type': 'text/html; charset=utf-8' },
            html(
              '<title>Fallback</title><meta property="og:title" content="Big &amp; bold‮ news">' +
                '<meta name="description" content="  A   story  "><meta property="og:site_name" content="News">',
            ),
          ),
      },
    );
    const preview = await fetchLinkPreview('https://news.example/story', t);
    expect(preview).toEqual({
      url: 'https://news.example/story',
      title: 'Big & bold news',
      description: 'A story',
      siteName: 'News',
    });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ address: '93.184.216.34' });
    expect(t.calls[0]?.headers).toEqual({
      host: 'news.example',
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
      'accept-encoding': 'identity',
    });
  });

  it.each([
    ['private DNS answer', { 'evil.example': ['10.0.0.5'] }, 'https://evil.example/'],
    ['metadata DNS answer', { 'evil.example': ['169.254.169.254'] }, 'https://evil.example/'],
    [
      'mixed (rebinding) answer',
      { 'evil.example': ['93.184.216.34', '127.0.0.1'] },
      'https://evil.example/',
    ],
    ['IPv6 loopback answer', { 'evil.example': ['::1'] }, 'https://evil.example/'],
    ['IPv4 literal', {}, 'https://127.0.0.1/'],
    ['decimal IPv4 literal', {}, 'https://2130706433/'],
    ['hex IPv4 literal', {}, 'https://0x7f000001/'],
    ['octal IPv4 literal', {}, 'https://0177.0.0.1/'],
    ['short IPv4 literal', {}, 'https://127.1/'],
    ['IPv6 literal', {}, 'https://[::1]/'],
    ['mapped IPv6 literal', {}, 'https://[::ffff:169.254.169.254]/'],
  ])('refuses a %s without connecting', async (_name, dns, url) => {
    const t = transport(dns, {});
    expect(await reason(fetchLinkPreview(url, t))).toBe('blocked_address');
    expect(t.calls).toHaveLength(0);
  });

  it('re-validates every redirect and stops after three', async () => {
    const redirect = (to: string) => () => response(302, { location: to });
    const toMetadata = transport(
      { 'a.example': ['93.184.216.34'] },
      { 'https://a.example/': redirect('https://169.254.169.254/latest/meta-data/') },
    );
    expect(await reason(fetchLinkPreview('https://a.example/', toMetadata))).toBe(
      'blocked_address',
    );
    expect(toMetadata.calls).toHaveLength(1);

    const toHttp = transport(
      { 'a.example': ['93.184.216.34'] },
      { 'https://a.example/': redirect('http://a.example/') },
    );
    expect(await reason(fetchLinkPreview('https://a.example/', toHttp))).toBe('invalid_url');

    const loop = transport(
      { 'a.example': ['93.184.216.34'] },
      {
        'https://a.example/1': redirect('/2'),
        'https://a.example/2': redirect('/3'),
        'https://a.example/3': redirect('/4'),
        'https://a.example/4': redirect('/5'),
      },
    );
    expect(await reason(fetchLinkPreview('https://a.example/1', loop))).toBe('too_many_redirects');
    expect(loop.calls).toHaveLength(4);
  });

  it('accepts only uncompressed HTML within the size cap', async () => {
    const page = (headers: Record<string, string>, body: string | Buffer[] = html('')) =>
      transport(
        { 'a.example': ['93.184.216.34'] },
        { 'https://a.example/': () => response(200, headers, body) },
      );
    expect(
      await reason(fetchLinkPreview('https://a.example/', page({ 'content-type': 'image/png' }))),
    ).toBe('not_html');
    expect(
      await reason(
        fetchLinkPreview(
          'https://a.example/',
          page({ 'content-type': 'text/html', 'content-encoding': 'gzip' }),
        ),
      ),
    ).toBe('not_html');
    const huge = Array.from({ length: 40 }, () => Buffer.alloc(64 * 1024, 'a'));
    expect(
      await reason(
        fetchLinkPreview('https://a.example/', page({ 'content-type': 'text/html' }, huge)),
      ),
    ).toBe('too_large');
    expect(huge.length * 64 * 1024).toBeGreaterThan(MAX_BYTES);
    expect(
      await reason(
        fetchLinkPreview(
          'https://a.example/',
          transport(
            { 'a.example': ['93.184.216.34'] },
            { 'https://a.example/': () => response(404, {}) },
          ),
        ),
      ),
    ).toBe('http_error');
  });

  it('gives up after the deadline', async () => {
    vi.useFakeTimers();
    const slow: SafeFetchTransport = {
      resolve: () => Promise.resolve(['93.184.216.34']),
      get: (_url, _address, _headers, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    };
    const result = reason(fetchLinkPreview('https://slow.example/', slow));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe('timeout');
  });

  it('reports unresolvable names and refuses localhost with the real resolver', async () => {
    expect(await reason(fetchLinkPreview('https://nowhere.example/', transport({}, {})))).toBe(
      'dns',
    );
    expect(await reason(fetchLinkPreview('https://localhost/'))).toBe('blocked_address');
  });
});

describe('head metadata', () => {
  it('reads only the head, decodes entities and ignores comments', () => {
    const parsed = parseHeadMetadata(
      '<head><!-- <meta property="og:title" content="hidden"> --><title>T &#8211; &#x41;</title></head>' +
        '<body><meta property="og:title" content="from body"></body>',
    );
    expect(parsed).toEqual({ title: 'T – A', description: null, siteName: null });
    expect(parseHeadMetadata(`<title>${'x'.repeat(500)}</title>`).title).toHaveLength(200);
  });
});
