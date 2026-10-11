import { describe, expect, it } from 'vitest';

import { isDangerousFile, safeFileName } from './attachments.js';
import { contentSchema } from './content.js';
import { testId } from '../test/ids.js';

const b64 = (bytes: number) => btoa('x'.repeat(bytes));
const reference = {
  blobId: '0192f0c1-0000-7000-8000-000000000001',
  key: b64(32),
  plaintextSha256: b64(32),
  ciphertextSha256: b64(32),
  plaintextSize: 10,
  ciphertextSize: 49,
};
const base = { v: 1, id: testId('id-1'), sentAt: 1 };
const media = (attachment: Record<string, unknown>) => ({
  ...base,
  body: {
    kind: 'media',
    attachment: {
      media: reference,
      category: 'image',
      mime: 'image/jpeg',
      name: 'a.jpg',
      ...attachment,
    },
  },
});

describe('attachment content', () => {
  it('accepts well-formed attachment messages and rejects malformed or oversized ones', () => {
    expect(
      contentSchema.safeParse(media({ width: 10, height: 10, thumbnail: b64(30) })).success,
    ).toBe(true);
    for (const bad of [
      { mime: 'text/html; charset=utf-8' },
      { mime: 'not a type' },
      { category: 'script' },
      { name: 'x'.repeat(256) },
      { thumbnail: 'x'.repeat(40_000) },
      { thumbnail: '<svg onload=alert(1)>' },
      { waveform: Array.from({ length: 65 }, () => 1) },
      { width: 0 },
      { media: { ...reference, key: b64(16) } },
      { media: { ...reference, extra: true } },
    ]) {
      expect(contentSchema.safeParse(media(bad)).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('safeFileName', () => {
  it('drops paths, control and bidi-override characters, and leading dots', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(safeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(safeFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(safeFileName('...hidden')).toBe('hidden');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('x'.repeat(300))).toHaveLength(200);
  });

  it('flags files that can run code', () => {
    expect(isDangerousFile('setup.exe', 'application/octet-stream')).toBe(true);
    expect(isDangerousFile('page.html', 'text/plain')).toBe(true);
    expect(isDangerousFile('logo.svg', 'image/svg+xml')).toBe(true);
    expect(isDangerousFile('report.docm', 'application/octet-stream')).toBe(true);
    expect(isDangerousFile('notes.txt', 'text/plain')).toBe(false);
    expect(isDangerousFile('photo.jpg', 'image/jpeg')).toBe(false);
  });
});
