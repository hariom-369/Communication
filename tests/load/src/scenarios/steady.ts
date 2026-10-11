import type { Context } from '../cli.js';

/**
 * Steady chat (docs/load-testing.md §2): every account holds one realtime socket; messages go
 * into random direct conversations at a fixed open-loop rate. Measures the API's send latency,
 * end-to-end delivery latency (send start → frame on the peer's socket) and loss.
 */
export async function steady(context: Context): Promise<Record<string, unknown>> {
  const { options, log } = context;
  log(`connecting ${String(options.users)} sockets at ${String(options.connectRate)}/s`);
  const connectStarted = Date.now();
  await context.all({ cmd: 'connect', rate: options.connectRate });
  const connectS = (Date.now() - connectStarted) / 1000;
  const connected = await context.report(true);
  log(`connected ${String(connected.connected)} in ${connectS.toFixed(0)} s`);

  log(`warm-up: ${String(options.rate)} msg/s for ${String(options.warmupS)} s`);
  await context.all({
    cmd: 'send',
    rate: options.rate,
    durationMs: options.warmupS * 1000,
    kind: 'direct',
    payloadBytes: options.payloadBytes,
  });
  await context.sleep(3000);
  await context.report(true);

  log(`measuring: ${String(options.rate)} msg/s for ${String(options.durationS)} s`);
  context.monitor.start();
  await context.all({
    cmd: 'send',
    rate: options.rate,
    durationMs: options.durationS * 1000,
    kind: 'direct',
    payloadBytes: options.payloadBytes,
  });
  await context.sleep(5000); // let in-flight deliveries land
  const resources = context.monitor.stop();
  const report = await context.report(false);
  const sent = report.counters['sent'] ?? 0;
  // Both members of a direct conversation are online: the peer and the sender's own socket.
  const expected = sent * 2;
  const delivered = report.counters['delivered'] ?? 0;
  return {
    sockets: {
      target: options.users,
      connected: connected.connected,
      rampSeconds: Math.round(connectS),
    },
    connectLatencyMs: connected.connect,
    messages: {
      targetPerSecond: options.rate,
      achievedPerSecond: Math.round((sent / options.durationS) * 10) / 10,
      sent,
      sendErrors: Object.entries(report.counters)
        .filter(([name]) => name.startsWith('send_'))
        .reduce((sum, [, value]) => sum + value, 0),
    },
    sendLatencyMs: report.send,
    deliveryLatencyMs: report.delivery,
    deliveries: { expected, delivered, lost: Math.max(0, expected - delivered) },
    stillConnected: report.connected,
    counters: report.counters,
    resources,
  };
}
