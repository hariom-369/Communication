import type { HealthState } from './health.js';
import type { Logger } from './logger.js';

export interface ShutdownStep {
  readonly name: string;
  run(): Promise<void>;
}

export interface Lifecycle extends HealthState {
  markStarted(): void;
  /** Registers cleanup; steps run in reverse registration order (last opened, first closed). */
  onShutdown(step: ShutdownStep): void;
  /** Drains, runs shutdown steps, and resolves with the intended process exit code. */
  shutdown(reason: string): Promise<number>;
}

export interface LifecycleOptions {
  logger: Logger;
  /** Time readiness reports "draining" before connections are closed, so LBs deregister us. */
  drainDelayMs: number;
  /** Hard limit for the whole shutdown sequence. */
  shutdownTimeoutMs: number;
}

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  let started = false;
  let draining = false;
  let inFlight: Promise<number> | undefined;
  const steps: ShutdownStep[] = [];

  async function runSteps(): Promise<number> {
    let exitCode = 0;
    for (const step of [...steps].reverse()) {
      try {
        await step.run();
      } catch (error) {
        exitCode = 1;
        options.logger.error('lifecycle.shutdown_step_failed', {
          component: step.name,
          ...options.logger.errorFields(error),
        });
      }
    }
    return exitCode;
  }

  return {
    isStarted: () => started,
    isDraining: () => draining,
    markStarted: () => {
      started = true;
    },
    onShutdown: (step) => {
      steps.push(step);
    },
    shutdown: (reason) => {
      inFlight ??= (async () => {
        draining = true;
        options.logger.info('lifecycle.shutdown_started', { signal: reason });
        await new Promise((resolve) => setTimeout(resolve, options.drainDelayMs));
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<number>((resolve) => {
          timer = setTimeout(() => {
            options.logger.error('lifecycle.shutdown_timeout', { signal: reason });
            resolve(1);
          }, options.shutdownTimeoutMs);
        });
        const exitCode = await Promise.race([runSteps(), timedOut]);
        clearTimeout(timer);
        options.logger.info('lifecycle.shutdown_complete', { signal: reason, ok: exitCode === 0 });
        return exitCode;
      })();
      return inFlight;
    },
  };
}
