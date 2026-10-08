import { BlockList, isIP } from 'node:net';

/**
 * Addresses the link-preview fetcher may never connect to (docs/security.md §6): private,
 * loopback, link-local, CGNAT, multicast, documentation, benchmarking, reserved and cloud
 * metadata ranges, for IPv4 and IPv6 — including IPv4 embedded in IPv6 (mapped, NAT64, 6to4,
 * Teredo), which are rejected outright or checked as the IPv4 they carry.
 */
const blocked = new BlockList();
const V4: readonly [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including 169.254.169.254 metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
];
const V6: readonly [string, number][] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated)
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments, including Teredo 2001::/32
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];
for (const [network, prefix] of V4) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of V6) blocked.addSubnet(network, prefix, 'ipv6');

const MAPPED = /^(?:0{1,4}:){5}ffff:|^::ffff:/i;
const NAT64 = /^64:ff9b::/i;

/** The IPv4 address in the low 32 bits of a NAT64 (64:ff9b::/96) address. */
function nat64Ipv4(address: string): string | null {
  const tail = address.slice(address.lastIndexOf(':') + 1);
  if (isIP(tail) === 4) return tail;
  const hex = /:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex === null) return null;
  const high = Number.parseInt(hex[1] ?? '0', 16);
  const low = Number.parseInt(hex[2] ?? '0', 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** True only for a syntactically valid, publicly routable unicast address. */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false; // zone identifiers are link-local by nature
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  // IPv4-mapped addresses are never needed for outbound fetches: refuse them outright.
  if (MAPPED.test(address)) return false;
  if (NAT64.test(address)) {
    const v4 = nat64Ipv4(address);
    return v4 !== null && isPublicAddress(v4);
  }
  return !blocked.check(address, 'ipv6');
}
