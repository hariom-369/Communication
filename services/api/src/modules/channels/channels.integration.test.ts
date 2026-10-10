import {
  CHANNEL_PERMISSIONS,
  channelPostSchema,
  channelSchema,
  postListSchema,
} from '@tessera/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';

/**
 * Channels (docs/channels.md, ADR-046): roles and permissions, private visibility, publishing
 * and scheduling (exactly once), reactions, polls, comments with slow mode, views and analytics,
 * search, invite links, ownership transfer with a cooling-off period.
 */

let env: IntegrationApp;
beforeAll(async () => {
  env = await startIntegrationApp();
});
afterAll(async () => {
  await env.close();
});

async function user() {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  return { ...created, id: me.id };
}
type User = Awaited<ReturnType<typeof user>>;

let handleCounter = 0;
async function channel(owner: User, overrides: Record<string, unknown> = {}): Promise<string> {
  handleCounter += 1;
  const response = await owner.client.post('/api/v1/channels', {
    handle: `ch_${Date.now().toString(36)}_${handleCounter}`,
    title: 'Daily news',
    description: 'Things that happened',
    visibility: 'public',
    commentsEnabled: true,
    slowModeSeconds: 0,
    ...overrides,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function post(author: User, id: string, body: Record<string, unknown>) {
  return author.client.post(`/api/v1/channels/${id}/posts`, {
    body: 'Hello subscribers',
    previewUrl: null,
    poll: null,
    publish: 'now',
    ...body,
  });
}

async function feed(viewer: User, id: string, query = '') {
  const response = await viewer.client.get(`/api/v1/channels/${id}/posts${query}`);
  return response.statusCode === 200 ? postListSchema.parse(response.json()) : null;
}

async function view(viewer: User, id: string) {
  const response = await viewer.client.get(`/api/v1/channels/${id}`);
  return response.statusCode === 200 ? channelSchema.parse(response.json()) : null;
}

describe("'channels.create', 'channels.get', 'channels.by_handle', 'channels.update', 'channels.mine', 'channels.discover', 'channels.subscribe', 'channels.unsubscribe' and 'channels.delete'", () => {
  it('creates, finds and subscribes; private channels are invisible to outsiders', async () => {
    const [owner, reader] = [await user(), await user()];
    const handle = `news_${Date.now().toString(36)}`;
    const id = await channel(owner, { handle, title: `Morning ${handle}` });
    expect(
      (
        await owner.client.post('/api/v1/channels', {
          handle,
          title: 'Again',
          description: '',
          visibility: 'public',
          commentsEnabled: true,
          slowModeSeconds: 0,
        })
      ).statusCode,
    ).toBe(409);
    expect((await reader.client.get(`/api/v1/channel-handles/${handle}`)).json()).toEqual({ id });
    const found = await reader.client.get(`/api/v1/channel-directory?q=${handle}`);
    expect(found.json<{ channels: { id: string }[] }>().channels.map((c) => c.id)).toEqual([id]);

    expect((await view(reader, id))?.me).toEqual({
      subscribed: false,
      notifications: false,
      owner: false,
      permissions: 0,
    });
    expect((await reader.client.post(`/api/v1/channels/${id}/subscription`, {})).statusCode).toBe(
      200,
    );
    expect((await reader.client.post(`/api/v1/channels/${id}/subscription`, {})).statusCode).toBe(
      200,
    );
    expect((await view(reader, id))?.subscriberCount).toBe(2); // owner + reader, counted once
    const mine = await reader.client.get('/api/v1/channels');
    expect(mine.json<{ channels: { id: string }[] }>().channels.map((c) => c.id)).toContain(id);
    expect((await reader.client.delete(`/api/v1/channels/${id}/subscription`)).statusCode).toBe(
      200,
    );
    expect((await view(reader, id))?.subscriberCount).toBe(1);

    // Only admins with the permission edit; private channels vanish for outsiders.
    expect(
      (await reader.client.patch(`/api/v1/channels/${id}`, { title: 'Mine now' })).statusCode,
    ).toBe(403);
    expect(
      (await owner.client.patch(`/api/v1/channels/${id}`, { visibility: 'private' })).statusCode,
    ).toBe(200);
    expect(await view(reader, id)).toBeNull();
    expect((await reader.client.get(`/api/v1/channel-handles/${handle}`)).statusCode).toBe(404);
    expect((await reader.client.post(`/api/v1/channels/${id}/subscription`, {})).statusCode).toBe(
      404,
    );
    expect(
      (await reader.client.get(`/api/v1/channel-directory?q=${handle}`)).json<{
        channels: unknown[];
      }>().channels,
    ).toEqual([]);

    expect((await reader.client.delete(`/api/v1/channels/${id}`)).statusCode).toBe(404);
    expect((await owner.client.delete(`/api/v1/channels/${id}`)).statusCode).toBe(200);
    expect(await view(owner, id)).toBeNull();
    const audit = await env.db
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', id)
      .execute();
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['channels.created', 'channels.updated', 'channels.deleted']),
    );
  });
});

describe("'channels.create_post', 'channels.posts', 'channels.update_post', 'channels.publish_post', 'channels.delete_post' and 'channels.search'", () => {
  it('publishes, schedules exactly once, paginates and enforces author rights', async () => {
    const [owner, editor, reader] = [await user(), await user(), await user()];
    const id = await channel(owner);
    await reader.client.post(`/api/v1/channels/${id}/subscription`, {});
    expect((await post(reader, id, {})).statusCode).toBe(403);

    const published = channelPostSchema.parse(
      (await post(owner, id, { body: 'First light' })).json(),
    );
    expect(published).toMatchObject({ status: 'published', body: 'First light' });
    for (let i = 0; i < 4; i += 1) await post(owner, id, { body: `Update number ${i}` });
    const first = await feed(reader, id, '?limit=3');
    expect(first?.posts.map((p) => p.body)).toEqual([
      'Update number 3',
      'Update number 2',
      'Update number 1',
    ]);
    const second = await feed(reader, id, `?limit=3&before=${first?.nextCursor ?? ''}`);
    expect(second?.posts.map((p) => p.body)).toEqual(['Update number 0', 'First light']);
    expect(second?.nextCursor).toBeNull();

    // Scheduling: invisible until due, then published once even if the scheduler runs twice.
    const at = new Date(Date.now() + 120_000).toISOString();
    const scheduled = channelPostSchema.parse(
      (await post(owner, id, { body: 'Later edition', publish: at })).json(),
    );
    expect(scheduled.status).toBe('scheduled');
    expect(
      (await post(owner, id, { publish: new Date(Date.now() + 1000).toISOString() })).statusCode,
    ).toBe(400);
    expect((await feed(reader, id))?.posts.map((p) => p.body)).not.toContain('Later edition');
    expect(
      (await reader.client.get(`/api/v1/channels/${id}/posts?status=scheduled`)).statusCode,
    ).toBe(403);
    expect((await feed(owner, id, '?status=scheduled'))?.posts.map((p) => p.id)).toEqual([
      scheduled.id,
    ]);
    const later = new Date(Date.now() + 180_000);
    const [run1, run2] = await Promise.all([
      env.modules.channels.runDue(later),
      env.modules.channels.runDue(later),
    ]);
    expect(run1.published + run2.published).toBe(1);
    expect((await feed(reader, id))?.posts[0]?.body).toBe('Later edition');

    // Drafts are shared among admins who can post, and published on demand.
    await owner.client.post(`/api/v1/channels/${id}/admins`, {
      username: editor.username,
      permissions: CHANNEL_PERMISSIONS.post,
    });
    const draft = channelPostSchema.parse(
      (await post(editor, id, { body: 'Draft idea', publish: 'draft' })).json(),
    );
    expect((await feed(owner, id, '?status=draft'))?.posts.map((p) => p.id)).toEqual([draft.id]);
    const live = await editor.client.post(`/api/v1/channels/${id}/posts/${draft.id}/publish`, {});
    expect(channelPostSchema.parse(live.json()).status).toBe('published');

    // Authors edit their own posts; editing someone else's needs editAny.
    expect(
      (
        await editor.client.patch(`/api/v1/channels/${id}/posts/${published.id}`, {
          body: 'Hijack',
        })
      ).statusCode,
    ).toBe(403);
    const edited = await editor.client.patch(`/api/v1/channels/${id}/posts/${draft.id}`, {
      body: 'Draft idea, revised',
    });
    expect(channelPostSchema.parse(edited.json()).editedAt).not.toBeNull();
    expect(
      (await editor.client.delete(`/api/v1/channels/${id}/posts/${published.id}`)).statusCode,
    ).toBe(403);
    expect((await owner.client.delete(`/api/v1/channels/${id}/posts/${draft.id}`)).statusCode).toBe(
      200,
    );
    expect((await feed(reader, id))?.posts.map((p) => p.id)).not.toContain(draft.id);
    const audit = await env.db
      .selectFrom('audit_log')
      .select('action')
      .where('actor_id', '=', owner.id)
      .execute();
    expect(audit.map((row) => row.action)).toContain('channels.post_removed');

    // Full-text search over published posts only.
    const results = await reader.client.get(
      `/api/v1/channels/${id}/search?q=${encodeURIComponent('later edition')}`,
    );
    expect(postListSchema.parse(results.json()).posts.map((p) => p.body)).toEqual([
      'Later edition',
    ]);
  });
});

describe("'channels.react', 'channels.vote', 'channels.voters', 'channels.comments', 'channels.add_comment' and 'channels.delete_comment'", () => {
  it('counts one reaction and one vote per person; comments follow channel rules', async () => {
    const [owner, alice, bob, outsider] = [await user(), await user(), await user(), await user()];
    const id = await channel(owner, { slowModeSeconds: 60 });
    for (const u of [alice, bob]) await u.client.post(`/api/v1/channels/${id}/subscription`, {});
    const created = channelPostSchema.parse(
      (
        await post(owner, id, {
          body: 'Which day?',
          poll: {
            question: 'Meet when?',
            options: ['Mon', 'Tue', 'Wed'],
            multiple: false,
            anonymous: false,
          },
        })
      ).json(),
    );
    const base = `/api/v1/channels/${id}/posts/${created.id}`;

    await alice.client.put(`${base}/reaction`, { emoji: '🔥' });
    await alice.client.put(`${base}/reaction`, { emoji: '👍' });
    const reacted = channelPostSchema.parse(
      (await bob.client.put(`${base}/reaction`, { emoji: '👍' })).json(),
    );
    expect(reacted.reactions).toEqual([{ emoji: '👍', count: 2 }]);
    expect((await alice.client.put(`${base}/reaction`, { emoji: '🤡' })).statusCode).toBe(400);

    expect((await alice.client.put(`${base}/vote`, { choices: [0, 1] })).statusCode).toBe(400);
    await alice.client.put(`${base}/vote`, { choices: [1] });
    const voted = channelPostSchema.parse(
      (await bob.client.put(`${base}/vote`, { choices: [1] })).json(),
    );
    expect(voted.poll).toMatchObject({ counts: [0, 2, 0], voters: 2, myChoices: [1] });
    const voters = await owner.client.get(`${base}/voters`);
    expect(
      voters.json<{ options: { usernames: string[] }[] }>().options[1]?.usernames.sort(),
    ).toEqual([alice.username, bob.username].sort());

    // Comments: subscribers only; slow mode for non-moderators; moderators delete others'.
    const comment = await alice.client.post(`${base}/comments`, { body: 'Tuesday works' });
    expect(comment.statusCode, comment.body).toBe(201);
    const again = await alice.client.post(`${base}/comments`, { body: 'Or Wednesday' });
    expect(again.statusCode).toBe(429);
    expect(again.json<{ retryAfterSeconds: number }>().retryAfterSeconds).toBeGreaterThan(0);
    expect((await outsider.client.post(`${base}/comments`, { body: 'Drive-by' })).statusCode).toBe(
      403,
    );
    expect((await owner.client.post(`${base}/comments`, { body: 'Noted' })).statusCode).toBe(201);
    expect((await owner.client.post(`${base}/comments`, { body: 'Twice' })).statusCode).toBe(201);
    const list = await bob.client.get(`${base}/comments`);
    const comments = list.json<{ comments: { id: string; body: string }[] }>().comments;
    expect(comments.map((c) => c.body)).toEqual(['Tuesday works', 'Noted', 'Twice']);
    const aliceComment = comments[0]?.id ?? '';
    expect(
      (await bob.client.delete(`/api/v1/channels/${id}/comments/${aliceComment}`)).statusCode,
    ).toBe(403);
    expect(
      (await owner.client.delete(`/api/v1/channels/${id}/comments/${aliceComment}`)).statusCode,
    ).toBe(200);
    expect(
      channelPostSchema.parse((await bob.client.put(`${base}/reaction`, { emoji: null })).json()),
    ).toMatchObject({
      commentCount: 2,
      reactions: [{ emoji: '👍', count: 1 }],
    });

    // Turning comments off stops new comments.
    await owner.client.patch(`/api/v1/channels/${id}`, { commentsEnabled: false });
    expect((await bob.client.post(`${base}/comments`, { body: 'Late' })).statusCode).toBe(403);

    // Anonymous polls never reveal voters.
    const secret = channelPostSchema.parse(
      (
        await post(owner, id, {
          body: '',
          poll: { question: 'Secret?', options: ['Yes', 'No'], multiple: true, anonymous: true },
        })
      ).json(),
    );
    expect(
      (await owner.client.get(`/api/v1/channels/${id}/posts/${secret.id}/voters`)).statusCode,
    ).toBe(404);
  });
});

describe("'channels.record_views' and 'channels.analytics'", () => {
  it('counts unique viewers per day and shows only aggregates', async () => {
    const [owner, alice, bob] = [await user(), await user(), await user()];
    const id = await channel(owner);
    await alice.client.post(`/api/v1/channels/${id}/subscription`, {});
    const created = channelPostSchema.parse((await post(owner, id, { body: 'Seen?' })).json());
    for (const viewer of [alice, alice, bob, owner])
      expect(
        (await viewer.client.post(`/api/v1/channels/${id}/views`, { postIds: [created.id] }))
          .statusCode,
      ).toBe(200);
    expect((await alice.client.get(`/api/v1/channels/${id}/analytics`)).statusCode).toBe(403);
    const analytics = await owner.client.get(`/api/v1/channels/${id}/analytics`);
    expect(analytics.statusCode, analytics.body).toBe(200);
    const data = analytics.json<{
      subscriberCount: number;
      days: { joined: number; views: number }[];
      posts: { id: string; views: number }[];
    }>();
    expect(data.subscriberCount).toBe(2);
    expect(data.posts[0]).toMatchObject({ id: created.id, views: 3 });
    expect(data.days.at(-1)).toMatchObject({ joined: 2, views: 3 });
    expect(JSON.stringify(data)).not.toContain(alice.id);

    await env.modules.channels.rollUpViews();
    const rolled = await env.db
      .selectFrom('channel_post_views')
      .select('views')
      .where('post_id', '=', created.id)
      .executeTakeFirst();
    expect(Number(rolled?.views)).toBe(3);
  });
});

describe("'channels.admins', 'channels.add_admin', 'channels.set_admin', 'channels.remove_admin', 'channels.request_transfer' and 'channels.cancel_transfer'", () => {
  it('limits what admins can grant and delays ownership changes', async () => {
    const [owner, manager, helper] = [await user(), await user(), await user()];
    const id = await channel(owner);
    const add = (actor: User, target: User, permissions: number) =>
      actor.client.post(`/api/v1/channels/${id}/admins`, {
        username: target.username,
        permissions,
      });
    expect(
      (await add(owner, manager, CHANNEL_PERMISSIONS.manageAdmins | CHANNEL_PERMISSIONS.post))
        .statusCode,
    ).toBe(200);
    expect((await add(manager, helper, CHANNEL_PERMISSIONS.deleteAny)).statusCode).toBe(403);
    expect((await add(manager, helper, CHANNEL_PERMISSIONS.post)).statusCode).toBe(200);
    expect(
      (
        await manager.client.put(`/api/v1/channels/${id}/admins/${owner.id}`, {
          permissions: CHANNEL_PERMISSIONS.post,
        })
      ).statusCode,
    ).toBe(400);
    const admins = await helper.client.get(`/api/v1/channels/${id}/admins`);
    expect(admins.json<{ admins: { userId: string }[] }>().admins.map((a) => a.userId)).toEqual([
      owner.id,
      manager.id,
      helper.id,
    ]);
    expect(
      (await helper.client.delete(`/api/v1/channels/${id}/admins/${manager.id}`)).statusCode,
    ).toBe(403);
    expect(
      (await helper.client.delete(`/api/v1/channels/${id}/admins/${helper.id}`)).statusCode,
    ).toBe(200);

    // Ownership: only to an admin, effective after the cooling-off period, cancellable.
    expect(
      (await owner.client.post(`/api/v1/channels/${id}/ownership`, { userId: helper.id }))
        .statusCode,
    ).toBe(400);
    const requested = await owner.client.post(`/api/v1/channels/${id}/ownership`, {
      userId: manager.id,
    });
    expect(requested.statusCode, requested.body).toBe(200);
    expect((await view(owner, id))?.pendingTransfer?.toUserId).toBe(manager.id);
    await env.modules.channels.runDue(new Date(Date.now() + 3_600_000));
    expect((await view(owner, id))?.me.owner).toBe(true);
    expect((await owner.client.delete(`/api/v1/channels/${id}/ownership`)).statusCode).toBe(200);
    await env.modules.channels.runDue(new Date(Date.now() + 25 * 3_600_000));
    expect((await view(owner, id))?.me.owner).toBe(true);

    await owner.client.post(`/api/v1/channels/${id}/ownership`, { userId: manager.id });
    await env.modules.channels.runDue(new Date(Date.now() + 25 * 3_600_000));
    expect((await view(manager, id))?.me.owner).toBe(true);
    expect((await view(owner, id))?.me).toMatchObject({ owner: false, permissions: 127 });
    const actions = await env.db
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', id)
      .execute();
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'channels.admins_changed',
        'channels.ownership_requested',
        'channels.ownership_cancelled',
        'channels.ownership_transferred',
      ]),
    );
  });
});

describe("'channels.create_link', 'channels.links', 'channels.revoke_link', 'channels.preview_invite', 'channels.join_invite' and 'channels.link_preview'", () => {
  it('lets people into private channels by link, and refuses internal preview targets', async () => {
    const [owner, alice, bob] = [await user(), await user(), await user()];
    const id = await channel(owner, { visibility: 'private' });
    const created = await owner.client.post(`/api/v1/channels/${id}/links`, {
      expiresInHours: 24,
      maxUses: 1,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { token, id: linkId } = created.json<{ token: string; id: string }>();
    expect((await alice.client.get(`/api/v1/channels/${id}/links`)).statusCode).toBe(404);
    expect((await alice.client.get(`/api/v1/channel-invites/${token}`)).json()).toMatchObject({
      id,
      subscribed: false,
    });
    expect(
      (await alice.client.post(`/api/v1/channel-invites/${token}/subscription`, {})).json(),
    ).toEqual({ id });
    expect((await view(alice, id))?.me.subscribed).toBe(true);
    expect(
      (await bob.client.post(`/api/v1/channel-invites/${token}/subscription`, {})).statusCode,
    ).toBe(404);
    expect((await owner.client.delete(`/api/v1/channels/${id}/links/${linkId}`)).statusCode).toBe(
      200,
    );

    // The link-preview endpoint goes through the SSRF-hardened fetcher.
    for (const url of [
      'https://localhost/',
      'https://127.0.0.1/',
      'https://169.254.169.254/',
      'http://example.com/',
    ])
      expect((await owner.client.post('/api/v1/link-previews', { url })).json()).toBeNull();
    const withLink = channelPostSchema.parse(
      (await post(owner, id, { body: 'Look', previewUrl: 'https://[::1]/admin' })).json(),
    );
    expect(withLink.preview).toBeNull();
  });
});

describe('link preview cache', () => {
  it('caches previews and failures, so a URL is fetched at most once per period', async () => {
    const { LinkPreviewer } = await import('./previews.js');
    const { SafeFetchError } = await import('../../platform/safe-fetch/index.js');
    let fetches = 0;
    const previewer = new LinkPreviewer(env.valkey, `${env.keyPrefix}:t${Date.now()}`, (url) => {
      fetches += 1;
      if (url.includes('broken')) return Promise.reject(new SafeFetchError('http_error'));
      return Promise.resolve({ url, title: 'Title', description: null, siteName: null });
    });
    const ok = 'https://news.example/a';
    expect(await previewer.preview(ok)).toMatchObject({ title: 'Title' });
    expect(await previewer.preview(ok)).toMatchObject({ title: 'Title' });
    expect(await previewer.preview('https://news.example/broken')).toBeNull();
    expect(await previewer.preview('https://news.example/broken')).toBeNull();
    expect(fetches).toBe(2);
  });
});
