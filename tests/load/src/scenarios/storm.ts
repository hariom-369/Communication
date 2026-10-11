import type { Context } from '../cli.js';

/**
 * Reconnect storm (docs/load-testing.md §2; moved here from Phase 3): with every socket open and
 * chat traffic running, one realtime pod goes away — `drain` (a deploy: SIGTERM, reconnect
 * hints with jitter) or `crash` (SIGKILL: sockets just drop). Its clients reconnect to the
 * other pods with the web client's backoff. Measures time until everyone is back, reconnect
 * latency, ticket and upgrade errors, and the API's send latency while it happens.
 */
export async function storm(context: Context): Promise<Record<string, unknown>> {
  const { options, stack, log } = context;
  await context.all({ cmd: 'connect', rate: options.connectRate });
  const before = await context.report(true);
  log(`connected ${String(before.connected)}; background traffic ${String(options.rate)} msg/s`);
  context.monitor.start();
  const traffic = context.all({
    cmd: 'send',
    rate: options.rate,
    durationMs: (options.durationS + 20) * 1000,
    kind: 'direct',
    payloadBytes: options.payloadBytes,
  });
  // Awaited at the end; a failure must not surface earlier as an unhandled rejection.
  traffic.catch(() => undefined);
  await context.sleep(10_000);
  const target = stack.processes.find((p) => p.name === 'realtime-0');
  if (target === undefined) throw new Error('needs a realtime-0');
  const started = Date.now();
  let restart: Promise<unknown>;
  if (options.mode === 'crash') {
    log('killing realtime-0 (SIGKILL)');
    target.child.kill('SIGKILL');
    restart = new Promise((resolve) => target.child.once('exit', resolve)).then(() =>
      stack.restart('realtime-0').catch(() => undefined),
    );
  } else {
    log('draining realtime-0 (SIGTERM)');
    restart = stack.restart('realtime-0');
  }
  // How many are connected, every second, until everyone is back (or the window ends).
  const timeline: Record<string, number>[] = [];
  let recoveredS: number | null = null;
  let lowest = before.connected;
  while (Date.now() - started < options.durationS * 1000) {
    await context.sleep(1000);
    const now = await context.report(false);
    const s = Math.round((Date.now() - started) / 1000);
    timeline.push({ s, connected: now.connected, ...now.states });
    lowest = Math.min(lowest, now.connected);
    if (recoveredS === null && s > 2 && now.connected >= before.connected) {
      recoveredS = s;
      log(`all ${String(now.connected)} reconnected after ${String(s)} s`);
    }
  }
  await restart;
  await traffic;
  const resources = context.monitor.stop();
  const after = await context.report(false);
  return {
    mode: options.mode,
    sockets: { before: before.connected, lowest, after: after.connected },
    recoveredSeconds: recoveredS,
    reconnectLatencyMs: after.reconnect,
    sendLatencyMs: after.send,
    deliveryLatencyMs: after.delivery,
    counters: after.counters,
    timeline,
    resources,
  };
}
