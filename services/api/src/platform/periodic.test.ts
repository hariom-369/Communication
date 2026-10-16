import { createLogger, type JobMetrics } from '@tessera/platform';
import { MemoryDestination } from '@tessera/platform/testing';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startSingletonTask } from './periodic.js';

function setup(pool: Partial<pg.Pool>, metrics?: JobMetrics) {
  const destination = new MemoryDestination();
  const logger = createLogger({ service: 'test', level: 'info', errorDetails: false, destination });
  const task = vi.fn().mockResolvedValue(undefined);
  const runner = startSingletonTask({
    name: 'test',
    lockKey: 1,
    intervalMs: 1000,
    pool: pool as pg.Pool,
    logger,
    task,
    ...(metrics === undefined ? {} : { metrics }),
  });
  return { destination, task, runner };
}

function lockingClient() {
  const query = vi.fn().mockResolvedValue({ rows: [{ ok: true }] });
  const release = vi.fn();
  return { client: { query, release } as unknown as pg.PoolClient, query, release };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  vi.useFakeTimers();
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.useRealTimers();
});

describe('singleton periodic task', () => {
  it('survives a pool that cannot hand out a connection, and tries again next interval', async () => {
    const { client, release } = lockingClient();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))
      .mockResolvedValue(client);
    const { destination, task, runner } = setup({ connect });
    await vi.advanceTimersByTimeAsync(1000);
    // Let a would-be unhandled rejection surface.
    await vi.advanceTimersByTimeAsync(0);
    expect(unhandled).toEqual([]);
    expect(destination.lines.some((line) => line.includes('periodic.task_failed'))).toBe(true);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await runner.stop();
  });

  it('logs a failing task, unlocks and releases the connection', async () => {
    const { client, query, release } = lockingClient();
    const { destination, task, runner } = setup({ connect: vi.fn().mockResolvedValue(client) });
    task.mockRejectedValueOnce(new Error('boom'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(destination.lines.some((line) => line.includes('periodic.task_failed'))).toBe(true);
    expect(query).toHaveBeenLastCalledWith('SELECT pg_advisory_unlock($1)', [1]);
    expect(release).toHaveBeenCalledTimes(1);
    await runner.stop();
  });

  it('records each run as failed, skipped (lock held elsewhere) or ok', async () => {
    const { client, query } = lockingClient();
    query
      .mockResolvedValueOnce({ rows: [{ ok: false }] }) // lock held by another instance
      .mockResolvedValue({ rows: [{ ok: true }] });
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))
      .mockResolvedValue(client);
    const observe = vi.fn<JobMetrics['observe']>();
    const { runner } = setup({ connect }, { observe });
    await vi.advanceTimersByTimeAsync(3000);
    expect(observe.mock.calls.map(([job, result]) => [job, result])).toEqual([
      ['test', 'failed'],
      ['test', 'skipped'],
      ['test', 'ok'],
    ]);
    await runner.stop();
  });
});
