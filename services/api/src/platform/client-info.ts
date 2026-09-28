/**
 * Coarse client descriptions for session lists and new-sign-in alerts. We deliberately keep
 * only a network prefix (IPv4 /24, IPv6 /48) and a browser/OS family — enough for a user to
 * recognise a session, not enough to fingerprint them (docs/privacy.md §4).
 */

export function ipPrefix(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped?.[1] ?? ip;
  if (!address.includes(':')) {
    const octets = address.split('.');
    return octets.length === 4 ? `${octets.slice(0, 3).join('.')}.0/24` : 'unknown';
  }
  const [head = '', tail] = (address.toLowerCase().split('%')[0] ?? '').split('::');
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':');
  const parts = [
    ...headParts,
    ...Array<string>(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0'),
    ...tailParts,
  ];
  return `${parts
    .slice(0, 3)
    .map((part) => part.replace(/^0+(?=.)/, ''))
    .join(':')}::/48`;
}

const BROWSERS: readonly [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

export function userAgentSummary(userAgent: string | undefined): string {
  if (userAgent === undefined || userAgent === '') return 'Unknown device';
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Browser';
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return system === undefined ? browser : `${browser} on ${system}`;
}
