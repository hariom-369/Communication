import { describe, expect, it } from 'vitest';

import { financialYear, invoiceNumber, taxFor } from './tax.js';

describe('GST', () => {
  it('splits an inclusive price within the seller state into CGST and SGST', () => {
    const tax = taxFor({
      totalMinor: 9900,
      currency: 'INR',
      buyerCountry: 'IN',
      buyerState: 'KA',
      sellerState: 'KA',
    });
    expect(tax).toMatchObject({ taxableMinor: 8390, cgstMinor: 755, sgstMinor: 755, igstMinor: 0 });
    expect(tax.taxableMinor + tax.cgstMinor + tax.sgstMinor + tax.igstMinor).toBe(9900);
  });

  it('charges IGST across states', () => {
    const tax = taxFor({
      totalMinor: 99900,
      currency: 'INR',
      buyerCountry: 'IN',
      buyerState: 'MH',
      sellerState: 'KA',
    });
    expect(tax).toMatchObject({
      taxableMinor: 84661,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 15239,
    });
  });

  it('keeps every split exact for odd amounts', () => {
    for (let total = 1; total < 5000; total += 7) {
      const tax = taxFor({
        totalMinor: total,
        currency: 'INR',
        buyerCountry: 'IN',
        buyerState: 'KA',
        sellerState: 'KA',
      });
      expect(tax.taxableMinor + tax.cgstMinor + tax.sgstMinor).toBe(total);
      expect(Math.abs(tax.cgstMinor - tax.sgstMinor)).toBeLessThanOrEqual(1);
    }
  });

  it('treats buyers abroad as exports (zero-rated)', () => {
    expect(
      taxFor({
        totalMinor: 299,
        currency: 'USD',
        buyerCountry: 'DE',
        buyerState: null,
        sellerState: 'KA',
      }),
    ).toMatchObject({
      taxableMinor: 299,
      igstMinor: 0,
      note: expect.stringContaining('Export') as unknown,
    });
  });

  it('numbers invoices by Indian financial year (April to March, IST)', () => {
    expect(financialYear(new Date('2026-03-31T18:29:59Z'))).toBe('2025-26'); // 23:59:59 IST
    expect(financialYear(new Date('2026-03-31T18:30:00Z'))).toBe('2026-27'); // 1 April, 00:00 IST
    expect(financialYear(new Date('2099-12-31T00:00:00Z'))).toBe('2099-00');
    expect(invoiceNumber('2026-27', 42)).toBe('T/2026-27/000042');
    expect(invoiceNumber('2026-27', 999_999)).toHaveLength(16);
  });
});
