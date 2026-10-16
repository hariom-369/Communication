import { execSync } from 'node:child_process';

import type { Context } from '../cli.js';

/**
 * Valkey loss (docs/disaster-recovery.md §1, ops/runbooks/valkey-loss.md): with every socket open
 * and chat traffic running, Valkey is stopped for `--hold` seconds and started again, empty (it
 * holds only disposable state). Measures what users see meanwhile — sends accepted or refused,
 * sockets kept or lost — how long until everyone is connected again, and whether every message
 * sent during the outage reaches both its recipient and its sender's own socket, live or by the
 * client's catch-up.
 *
 * VALKEY_STOP_CMD and VALKEY_START_CMD are shell commands (the drill runs against a disposable
 * Valkey, e.g. `redis-cli -p 56379 shutdown nosave` and `redis-server --port 56379 --daemonize yes`).
 */
export async function valkeyLoss(context: Context): Promise<Record<string, unknown>> {
  const { options, log } = context;
  const stop = process.env['VALKEY_STOP_CMD'];
  const start = process.env['VALKEY_START_CMD'];
  if (stop === undefined || start === undefined)
    throw new Error('valkey-loss needs VALKEY_STOP_CMD and VALKEY_START_CMD');

  await context.all({ cmd: 'connect', rate: options.connectRate });
  const before = await context.report(true);
  log(`connected ${String(before.connected)}; traffic ${String(options.rate)} msg/s`);
  context.monitor.start();
  const settleS = 20;
  const traffic = context.all({
    cmd: 'send',
    rate: options.rate,
    durationMs: (10 + options.holdS + options.durationS) * 1000,
    kind: 'direct',
    payloadBytes: options.payloadBytes,
  });
  traffic.catch(() => undefined);
  await context.sleep(10_000);

  const timeline: Record<string, number>[] = [];
  const sample = async (s: number) => {
    const now = await context.report(false);
    const sendErrors = Object.entries(now.counters)
      .filter(([name]) => name.startsWith('send_'))
      .reduce((sum, [, n]) => sum + n, 0);
    timeline.push({
      s,
      connected: now.connected,
      sent: now.counters['sent'] ?? 0,
      sendErrors,
      delivered: now.counters['delivered'] ?? 0,
      recovered: now.counters['recovered'] ?? 0,
    });
    return now;
  };

  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  log(`stopping Valkey for ${String(options.holdS)} s`);
  execSync(stop, { stdio: 'ignore' });
  let lowest = before.connected;
  while (Date.now() - started < options.holdS * 1000) {
    await context.sleep(1000);
    lowest = Math.min(lowest, (await sample(elapsed())).connected);
  }
  log('starting Valkey');
  execSync(start, { stdio: 'ignore' });
  const restarted = Date.now();
  let backAfterS: number | null = null;
  while (Date.now() - restarted < options.durationS * 1000) {
    await context.sleep(1000);
    const now = await sample(elapsed());
    lowest = Math.min(lowest, now.connected);
    if (backAfterS === null && now.connected >= before.connected) {
      backAfterS = Math.round((Date.now() - restarted) / 1000);
      log(`all ${String(now.connected)} connected ${String(backAfterS)} s after the restart`);
    }
  }
  await traffic;
  await context.sleep(settleS * 1000); // catch-up after the last reconnects
  const resources = context.monitor.stop();
  const after = await context.report(false);

  const at = (s: number) => timeline.find((row) => (row['s'] ?? 0) >= s);
  const outageStart = at(1);
  const outageEnd = at(options.holdS);
  const sent = after.counters['sent'] ?? 0;
  const delivered = after.counters['delivered'] ?? 0;
  const recovered = after.counters['recovered'] ?? 0;
  // Both members of a direct conversation are online: the peer and the sender's own socket.
  const expected = sent * 2;
  return {
    outageSeconds: options.holdS,
    sockets: { before: before.connected, lowest, after: after.connected },
    allConnectedSecondsAfterRestart: backAfterS,
    duringOutage:
      outageStart === undefined || outageEnd === undefined
        ? null
        : {
            sent: (outageEnd['sent'] ?? 0) - (outageStart['sent'] ?? 0),
            sendErrors: (outageEnd['sendErrors'] ?? 0) - (outageStart['sendErrors'] ?? 0),
            deliveredLive: (outageEnd['delivered'] ?? 0) - (outageStart['delivered'] ?? 0),
          },
    messages: {
      sent,
      expectedDeliveries: expected,
      deliveredLive: delivered,
      recoveredByCatchUp: recovered,
      missing: Math.max(0, expected - delivered - recovered),
    },
    counters: after.counters,
    sendLatencyMs: after.send,
    reconnectLatencyMs: after.reconnect,
    timeline,
    resources,
  };
}
