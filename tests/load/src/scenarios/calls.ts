import type { Context } from '../cli.js';

/**
 * Call-setup surge (docs/load-testing.md §2): `--rate` new 1:1 calls per second between online
 * users, each lasting `--hold` seconds: ICE credentials, start, ring on the callee's socket,
 * join, leave. (Media flows peer to peer or through TURN and never touches these services;
 * TURN/SFU capacity is a separate, hardware-bound measurement.) Measures ring latency and setup
 * latency (caller presses call → callee joined).
 */
export async function calls(context: Context): Promise<Record<string, unknown>> {
  const { options, log } = context;
  await context.all({ cmd: 'connect', rate: options.connectRate });
  const before = await context.report(true);
  log(`connected ${String(before.connected)}; ${String(options.rate)} call setups/s`);
  context.monitor.start();
  await context.all({
    cmd: 'calls',
    rate: options.rate,
    durationMs: options.durationS * 1000,
    holdMs: options.holdS * 1000,
  });
  const resources = context.monitor.stop();
  const report = await context.report(false);
  return {
    targetPerSecond: options.rate,
    holdSeconds: options.holdS,
    concurrentCallsAtSteadyState: Math.round(options.rate * options.holdS),
    ringLatencyMs: report.ring,
    setupLatencyMs: report.setup,
    counters: report.counters,
    resources,
  };
}
