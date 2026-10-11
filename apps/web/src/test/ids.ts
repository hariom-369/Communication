/**
 * A deterministic, valid UUIDv7 for a readable test label (`testId('peer')`): message and user
 * ids are validated as UUIDv7 wherever they become keys of client state (security review F-13),
 * so fixtures need real ones. Two FNV-1a variants give 64 bits per label; collisions between
 * the handful of labels a test uses are not a concern.
 */
export function testId(label: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const char of label) {
    const code = char.codePointAt(0) ?? 0;
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  const hex = a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  return `0190f000-${hex.slice(0, 4)}-7${hex.slice(4, 7)}-8${hex.slice(7, 10)}-${hex.slice(10, 16)}000000`;
}
