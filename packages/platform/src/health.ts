import Fastify, { type FastifyInstance } from 'fastify';

import type { Logger } from './logger.js';

/** A dependency check used by /readyz. Implementations must honour the abort signal. */
export interface HealthCheck {
  readonly name: string;
  check(signal: AbortSignal): Promise<void>;
}

export interface HealthState {
  /** True once the service finished booting (drives /startupz). */
  isStarted(): boolean;
  /** True while shutting down; readiness fails so load balancers stop routing. */
  isDraining(): boolean;
}

export interface HealthServerOptions {
  checks: readonly HealthCheck[];
  state: HealthState;
  logger: Logger;
  checkTimeoutMs: number;
}

type CheckStatus = 'ok' | 'fail' | 'timeout';

/**
 * Internal health server (docs/observability.md §5). It listens on a separate port that is never
 * exposed through the public load balancer, and it reports only pass/fail per check — no error
 * details — so it cannot leak internals even if misrouted.
 */
export function createHealthServer(options: HealthServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/livez', async (_request, reply) => reply.code(200).send({ status: 'ok' }));

  app.get('/startupz', async (_request, reply) => {
    const started = options.state.isStarted();
    return reply.code(started ? 200 : 503).send({ status: started ? 'ok' : 'starting' });
  });

  app.get('/readyz', async (_request, reply) => {
    if (options.state.isDraining()) return reply.code(503).send({ status: 'draining' });
    if (!options.state.isStarted()) return reply.code(503).send({ status: 'starting' });

    const results = await Promise.all(
      options.checks.map(async (check) => [check.name, await runCheck(check, options)] as const),
    );
    const ok = results.every(([, status]) => status === 'ok');
    return reply
      .code(ok ? 200 : 503)
      .send({ status: ok ? 'ok' : 'unavailable', checks: Object.fromEntries(results) });
  });

  return app;
}

async function runCheck(check: HealthCheck, options: HealthServerOptions): Promise<CheckStatus> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CheckStatus>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, options.checkTimeoutMs);
  });
  try {
    const status = await Promise.race([
      check.check(controller.signal).then((): CheckStatus => 'ok'),
      timeout,
    ]);
    if (status !== 'ok')
      options.logger.warn('health.check_failed', { check: check.name, ok: false });
    return status;
  } catch (error) {
    options.logger.warn('health.check_failed', {
      check: check.name,
      ok: false,
      ...options.logger.errorFields(error),
    });
    return 'fail';
  } finally {
    clearTimeout(timer);
  }
}
