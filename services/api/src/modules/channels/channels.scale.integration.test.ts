import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';

/**
 * Phase 8 exit criterion (docs/channels.md §7): publishing to a channel with 1,000,000
 * subscribers costs the same as publishing to an empty one — fan-out on read, no per-subscriber
 * writes. Inserting a million rows takes a while, so this runs only with TESSERA_SCALE_TESTS=1
 * (nightly CI and phase exits).
 */

const SUBSCRIBERS = 1_000_000;
const enabled = process.env['TESSERA_SCALE_TESTS'] === '1';

let env: IntegrationApp;
beforeAll(async () => {
  if (enabled) env = await startIntegrationApp();
});
afterAll(async () => {
  if (enabled) await env.close();
});

async function publishTimes(
  client: { post: (url: string, body: unknown) => Promise<{ statusCode: number }> },
  id: string,
) {
  const times: number[] = [];
  for (let i = 0; i < 15; i += 1) {
    const started = performance.now();
    const response = await client.post(`/api/v1/channels/${id}/posts`, {
      body: `Bulletin ${i}`,
      previewUrl: null,
      poll: null,
      publish: 'now',
    });
    expect(response.statusCode).toBe(201);
    times.push(performance.now() - started);
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? Infinity;
}

describe.runIf(enabled)('channels at scale', () => {
  it(
    'publishes to 1M subscribers without per-subscriber writes, as fast as to none',
    async () => {
      const owner = await createActiveUser(env);
      const create = (handle: string) =>
        owner.client.post('/api/v1/channels', {
          handle,
          title: handle,
          description: '',
          visibility: 'public',
          commentsEnabled: false,
          slowModeSeconds: 0,
        });
      const stamp = Date.now().toString(36);
      const big = (await create(`big_${stamp}`)).json<{ id: string }>().id;
      const small = (await create(`small_${stamp}`)).json<{ id: string }>().id;

      const batch = randomUUID().slice(0, 8);
      await sql`
        INSERT INTO users (id, username, status, accepted_terms_version, confirmed_adult_at)
        SELECT gen_random_uuid(), ${`s${batch}_`} || g, 'active', '1', now()
        FROM generate_series(1, ${SUBSCRIBERS}) AS g`.execute(env.db);
      await sql`
        INSERT INTO channel_subscribers (channel_id, user_id)
        SELECT ${big}::uuid, id FROM users WHERE username LIKE ${`s${batch}_%`}`.execute(env.db);
      await sql`
        INSERT INTO channel_subscriber_counts (channel_id, shard, count)
        VALUES (${big}::uuid, 0, ${SUBSCRIBERS})
        ON CONFLICT (channel_id, shard) DO UPDATE SET count = channel_subscriber_counts.count + ${SUBSCRIBERS}`.execute(
        env.db,
      );
      await sql`ANALYZE channel_subscribers`.execute(env.db);

      const tuples = async () =>
        Number(
          (
            await sql<{ n: string }>`SELECT n_tup_ins + n_tup_upd + n_tup_del AS n
              FROM pg_stat_user_tables WHERE relname = 'channel_subscribers'`.execute(env.db)
          ).rows[0]?.n ?? 0,
        );
      const before = await tuples();
      const smallMedian = await publishTimes(owner.client, small);
      const bigMedian = await publishTimes(owner.client, big);
      // Statistics are flushed asynchronously; wait for them before comparing.
      await sql`SELECT pg_stat_force_next_flush()`.execute(env.db);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const after = await tuples();

      const channel = await owner.client.get(`/api/v1/channels/${big}`);
      expect(channel.json<{ subscriberCount: number }>().subscriberCount).toBe(SUBSCRIBERS + 1);
      expect(after - before).toBe(0);
      // Same cost regardless of audience (generous bound for noisy CI machines).
      expect(bigMedian).toBeLessThan(Math.max(50, smallMedian * 3));
      process.stdout.write(
        `[scale] publish median: ${smallMedian.toFixed(1)} ms (1 subscriber) vs ${bigMedian.toFixed(1)} ms (${SUBSCRIBERS} subscribers)\n`,
      );
    },
    15 * 60_000,
  );
});
