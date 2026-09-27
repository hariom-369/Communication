import { afterEach, describe, expect, it } from 'vitest';

import { createHealthServer, type HealthCheck } from './health.js';
import { createLogger } from './logger.js';
import { MemoryDestination } from './testing/memory-destination.js';

const logger = createLogger({
  service: 'test',
  level: 'fatal',
  errorDetails: false,
  destination: new MemoryDestination(),
});

let state = { started: true, draining: false };
afterEach(() => {
  state = { started: true, draining: false };
});

function server(checks: HealthCheck[]) {
  return createHealthServer({
    checks,
    logger,
    checkTimeoutMs: 50,
    state: { isStarted: () => state.started, isDraining: () => state.draining },
  });
}

const ok: HealthCheck = { name: 'db', check: async () => {} };
const failing: HealthCheck = {
  name: 'cache',
  check: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.12:6379')),
};
const hanging: HealthCheck = {
  name: 'slow',
  check: (signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', reject);
    }),
};

describe('health server', () => {
  it('livez is independent of dependencies', async () => {
    const response = await server([failing]).inject('/livez');
    expect(response.statusCode).toBe(200);
  });

  it('readyz is 200 when all checks pass', async () => {
    const response = await server([ok]).inject('/readyz');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { db: 'ok' } });
  });

  it('readyz is 503 on failure or timeout and leaks no error details', async () => {
    const response = await server([ok, failing, hanging]).inject('/readyz');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'unavailable',
      checks: { db: 'ok', cache: 'fail', slow: 'timeout' },
    });
    expect(response.body).not.toContain('10.0.0.12');
  });

  it('readyz is 503 while draining or starting', async () => {
    state.draining = true;
    expect((await server([ok]).inject('/readyz')).statusCode).toBe(503);
    state = { started: false, draining: false };
    expect((await server([ok]).inject('/readyz')).statusCode).toBe(503);
    expect((await server([ok]).inject('/startupz')).statusCode).toBe(503);
  });
});
