import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';

/**
 * Ticket admission (docs/capacity.md §4): a cluster-wide budget of tickets per second, so the
 * reconnect wave after a realtime pod fails is spread out instead of stalling everyone else.
 */

let env: IntegrationApp;
beforeAll(async () => {
  env = await startIntegrationApp({ ticketsPerSecond: 3 });
});
afterAll(async () => {
  await env.close();
});

describe('realtime ticket admission', () => {
  it('issues at most the budget per second across all users, and asks the rest to retry', async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => createActiveUser(env)));
    // Let the budget refill after sign-up (which issues no tickets, but takes time).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const responses = await Promise.all(
      users.map((user) => user.client.post('/api/v1/realtime/ticket', {})),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 201, 201, 429, 429, 429]);
    // Refused together, told to come back at different times (1–10 s), so they do not return
    // together.
    const waits = responses
      .filter((response) => response.statusCode === 429)
      .map((response) => Number(response.headers['retry-after']));
    for (const wait of waits) {
      expect(Number.isInteger(wait)).toBe(true);
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(10);
    }
    // The budget refills: a refused user gets a ticket shortly after.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const retry = await users[5]!.client.post('/api/v1/realtime/ticket', {});
    expect(retry.statusCode).toBe(201);
  });
});
