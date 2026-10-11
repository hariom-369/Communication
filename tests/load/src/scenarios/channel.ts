import pg from 'pg';

import { apiRequest } from '../client.js';
import { Counters, Histogram, schedule } from '../metrics.js';
import { ORIGIN } from '../stack.js';
import type { Context } from '../cli.js';

/**
 * Channel publish to a huge audience (docs/load-testing.md §2, docs/channels.md §2): channels
 * fan out on read, so a post must cost the same whatever the audience. A channel gets every
 * seeded account plus `--subscribers` synthetic subscribers (default 1,000,000); its owner
 * publishes one post every 2 s while subscribers read the feed at `--rate` requests/s.
 * Measures publish latency, feed-read latency and per-subscriber writes (must be zero).
 */
export async function channel(context: Context): Promise<Record<string, unknown>> {
  const { options, stack, seed, log } = context;
  const owner = seed.users[0];
  if (owner === undefined) throw new Error('needs at least one account');
  const api = stack.endpoints.api[0] ?? '';
  const as = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    apiRequest(api, '127.0.0.1', owner.token, method, path, ORIGIN, body);
  const created = await as('POST', '/api/v1/channels', {
    handle: `load_${seed.runId}`,
    title: 'Load test',
    description: '',
    visibility: 'public',
    commentsEnabled: false,
    slowModeSeconds: 0,
  });
  if (created.status !== 201) throw new Error(`channel create ${String(created.status)}`);
  const channelId = (created.body as { id: string }).id;

  log(
    `subscribing ${String(seed.users.length)} accounts and ${String(options.subscribers)} synthetic subscribers`,
  );
  const db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  await db.query(
    `INSERT INTO channel_subscribers (channel_id, user_id)
     SELECT $1::uuid, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [channelId, seed.users.slice(1).map((u) => u.id)],
  );
  if (options.subscribers > 0) {
    await db.query(
      `INSERT INTO users (id, username, status, accepted_terms_version, confirmed_adult_at)
       SELECT gen_random_uuid(), $1 || g, 'active', 'load-test', now()
       FROM generate_series(1, $2::int) AS g`,
      [`sub_${seed.runId}_`, options.subscribers],
    );
    await db.query(
      `INSERT INTO channel_subscribers (channel_id, user_id)
       SELECT $1::uuid, id FROM users WHERE username LIKE $2`,
      [channelId, `sub_${seed.runId}_%`],
    );
  }
  await db.query(
    `INSERT INTO channel_subscriber_counts (channel_id, shard, count) VALUES ($1, 0, $2)
     ON CONFLICT (channel_id, shard) DO UPDATE SET count = channel_subscriber_counts.count + $2`,
    [channelId, seed.users.length - 1 + options.subscribers],
  );
  await db.query('ANALYZE channel_subscribers');
  const writes = async () =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT n_tup_ins + n_tup_upd + n_tup_del AS n FROM pg_stat_user_tables
           WHERE relname = 'channel_subscribers'`,
        )
      ).rows[0]?.n ?? 0,
    );
  // Other sessions (the API's) flush their statistics asynchronously: let earlier writes, such as
  // the owner's own subscription, land before taking the baseline.
  await db.query('SELECT pg_stat_force_next_flush()');
  await context.sleep(2000);
  const writesBefore = await writes();

  const publish = new Histogram();
  const counters = new Counters();
  context.monitor.start();
  const durationMs = options.durationS * 1000;
  const reads = context.all({
    cmd: 'http',
    rate: options.rate,
    durationMs,
    method: 'GET',
    path: '/api/v1/channels/{channel}/posts?limit=20',
    channel: channelId,
  });
  const started = Date.now();
  for (const at of schedule(0.5, durationMs)) {
    const wait = started + at - Date.now();
    if (wait > 0) await context.sleep(wait);
    const t0 = Date.now();
    const response = await as('POST', `/api/v1/channels/${channelId}/posts`, {
      body: `Post at ${new Date().toISOString()}`,
      previewUrl: null,
      poll: null,
      publish: 'now',
    });
    publish.record(Date.now() - t0);
    counters.add(`publish_${String(response.status)}`);
  }
  await reads;
  const resources = context.monitor.stop();
  await db.query('SELECT pg_stat_force_next_flush()');
  await context.sleep(1000);
  const writesAfter = await writes();
  await db.end();
  const report = await context.report(false);
  return {
    subscribers: seed.users.length - 1 + options.subscribers,
    publishLatencyMs: publish.summary(),
    publishes: Object.fromEntries(counters.values),
    feedReads: { targetPerSecond: options.rate, latencyMs: report.http },
    perSubscriberWrites: writesAfter - writesBefore,
    counters: report.counters,
    resources,
  };
}
