import { describe, expect, it } from 'vitest';

import { createLifecycle } from './lifecycle.js';
import { createLogger } from './logger.js';
import { MemoryDestination } from './testing/memory-destination.js';

const logger = createLogger({
  service: 'test',
  level: 'fatal',
  errorDetails: false,
  destination: new MemoryDestination(),
});

describe('lifecycle', () => {
  it('drains first, then runs steps in reverse order, once', async () => {
    const lifecycle = createLifecycle({ logger, drainDelayMs: 1, shutdownTimeoutMs: 1000 });
    const order: string[] = [];
    lifecycle.onShutdown({ name: 'db', run: async () => void order.push('db') });
    lifecycle.onShutdown({
      name: 'http',
      run: async () => {
        expect(lifecycle.isDraining()).toBe(true);
        order.push('http');
      },
    });
    const [a, b] = await Promise.all([lifecycle.shutdown('SIGTERM'), lifecycle.shutdown('SIGINT')]);
    expect(order).toEqual(['http', 'db']);
    expect([a, b]).toEqual([0, 0]);
  });

  it('continues after a failing step and reports a non-zero exit code', async () => {
    const lifecycle = createLifecycle({ logger, drainDelayMs: 0, shutdownTimeoutMs: 1000 });
    const ran: string[] = [];
    lifecycle.onShutdown({ name: 'a', run: async () => void ran.push('a') });
    lifecycle.onShutdown({ name: 'b', run: () => Promise.reject(new Error('boom')) });
    expect(await lifecycle.shutdown('SIGTERM')).toBe(1);
    expect(ran).toEqual(['a']);
  });

  it('times out hung steps', async () => {
    const lifecycle = createLifecycle({ logger, drainDelayMs: 0, shutdownTimeoutMs: 20 });
    lifecycle.onShutdown({ name: 'hang', run: () => new Promise(() => {}) });
    expect(await lifecycle.shutdown('SIGTERM')).toBe(1);
  });
});
