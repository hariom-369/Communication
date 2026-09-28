import type { Logger } from '@tessera/platform';
import type pg from 'pg';

/**
 * Runs `task` every `intervalMs` on at most one API instance at a time: each run first takes a
 * PostgreSQL session advisory lock and skips if another pod holds it.
 */
export function startSingletonTask(options: {
  name: string;
  lockKey: number;
  intervalMs: number;
  pool: pg.Pool;
  logger: Logger;
  task: () => Promise<unknown>;
}): { stop: () => Promise<void> } {
  let running: Promise<void> | undefined;
  let stopped = false;

  const run = async (): Promise<void> => {
    const client = await options.pool.connect();
    try {
      const locked = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
        options.lockKey,
      ]);
      if (locked.rows[0]?.ok !== true) return;
      try {
        await options.task();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [options.lockKey]);
      }
    } catch (error) {
      options.logger.error('periodic.task_failed', {
        component: options.name,
        ...options.logger.errorFields(error),
      });
    } finally {
      client.release();
    }
  };

  const timer = setInterval(() => {
    if (stopped || running !== undefined) return;
    running = run().finally(() => {
      running = undefined;
    });
  }, options.intervalMs);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
