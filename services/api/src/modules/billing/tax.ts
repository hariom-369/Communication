import type { Currency } from '@tessera/validation';

/**
 * GST on Tessera's subscriptions (docs/billing.md §5; rates, SAC and export treatment to be
 * confirmed by the tax adviser, L-11). Indian prices include 18% GST: within the seller's state
 * it is split into CGST and SGST (9% + 9%), otherwise it is IGST. Supplies to buyers outside India
 * are treated as exports of services (zero-rated, under a letter of undertaking).
 */

export const GST_RATE_PERCENT = 18;

export interface TaxBreakdown {
  readonly taxableMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly note: string;
}

export function taxFor(input: {
  totalMinor: number;
  currency: Currency;
  buyerCountry: string;
  buyerState: string | null;
  sellerState: string;
}): TaxBreakdown {
  if (input.buyerCountry !== 'IN')
    return {
      taxableMinor: input.totalMinor,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      note: 'Export of services: zero-rated supply under LUT, without payment of IGST.',
    };
  // Inclusive price: taxable value = total × 100 / 118, rounded to the nearest minor unit.
  const taxableMinor = Math.round((input.totalMinor * 100) / (100 + GST_RATE_PERCENT));
  const tax = input.totalMinor - taxableMinor;
  if (input.buyerState === input.sellerState) {
    const cgstMinor = Math.floor(tax / 2);
    return {
      taxableMinor,
      cgstMinor,
      sgstMinor: tax - cgstMinor,
      igstMinor: 0,
      note: 'CGST 9% + SGST 9% (intra-state supply).',
    };
  }
  return {
    taxableMinor,
    cgstMinor: 0,
    sgstMinor: 0,
    igstMinor: tax,
    note: 'IGST 18% (inter-state supply).',
  };
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** The Indian financial year (April–March, Indian Standard Time) of a moment: "2026-27". */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${String(year)}-${String((year + 1) % 100).padStart(2, '0')}`;
}

/** GST invoice numbers: at most 16 characters, consecutive within a financial year. */
export function invoiceNumber(year: string, serial: number): string {
  return `T/${year}/${String(serial).padStart(6, '0')}`;
}
