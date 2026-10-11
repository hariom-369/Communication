import type { Context } from '../cli.js';

/**
 * Large-group burst (docs/load-testing.md §2): a 1,024-member group (the E2EE cap) with every
 * member online; members post at a fixed rate. Every message fans out to 1,024 sockets.
 * Measures send latency, delivery latency across all members, and loss.
 */
export async function group(context: Context): Promise<Record<string, unknown>> {
  const { options, log } = context;
  await context.all({ cmd: 'connect', rate: options.connectRate });
  const before = await context.report(true);
  log(`connected ${String(before.connected)}; group of ${String(options.groupSize)}`);
  context.monitor.start();
  await context.all({
    cmd: 'send',
    rate: options.rate,
    durationMs: options.durationS * 1000,
    kind: 'group',
    payloadBytes: options.payloadBytes,
  });
  await context.sleep(10_000);
  const resources = context.monitor.stop();
  const report = await context.report(false);
  const sent = report.counters['sent'] ?? 0;
  const size = Math.min(options.groupSize, options.users);
  const expected = sent * size;
  const delivered = report.counters['delivered'] ?? 0;
  return {
    groupSize: size,
    messages: {
      targetPerSecond: options.rate,
      achievedPerSecond: Math.round((sent / options.durationS) * 10) / 10,
      sent,
      fanOutPerSecond: Math.round((expected / options.durationS) * 10) / 10,
    },
    sendLatencyMs: report.send,
    deliveryLatencyMs: report.delivery,
    deliveries: { expected, delivered, lost: Math.max(0, expected - delivered) },
    counters: report.counters,
    resources,
  };
}
