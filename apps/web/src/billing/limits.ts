import { TIER_LIMITS } from '@tessera/validation';

import { billingEndpoints } from '../api/billing-endpoints.js';

/**
 * The account's attachment size limit, looked up when a file is added (at most once a minute).
 * If the lookup fails, the free limit applies here; the server has the final word either way.
 */
let cached: { at: number; value: number } | null = null;

export async function maxFileBytes(now = Date.now()): Promise<number> {
  if (cached !== null && now - cached.at < 60_000) return cached.value;
  try {
    const { limits } = await billingEndpoints.entitlements();
    cached = { at: now, value: limits['media.max_file_bytes'] };
  } catch {
    return TIER_LIMITS.free['media.max_file_bytes'];
  }
  return cached.value;
}
