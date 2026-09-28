import { describe, expect, it } from 'vitest';

import { ipPrefix, userAgentSummary } from './client-info.js';

describe('ipPrefix', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0/24'],
    ['::ffff:203.0.113.77', '203.0.113.0/24'],
    ['2001:db8:abcd:12:1:2:3:4', '2001:db8:abcd::/48'],
    ['2001:0db8:0000::1', '2001:db8:0::/48'],
    ['garbage', 'unknown'],
  ])('%s -> %s', (ip, prefix) => {
    expect(ipPrefix(ip)).toBe(prefix);
  });
});

describe('userAgentSummary', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      'Chrome on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
      'Safari on macOS',
    ],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', 'Safari on iOS'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox on Linux'],
    ['curl/8.0', 'Browser'],
    [undefined, 'Unknown device'],
  ])('%s -> %s', (ua, summary) => {
    expect(userAgentSummary(ua)).toBe(summary);
  });
});
