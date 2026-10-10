import { createHash, createHmac, randomBytes } from 'node:crypto';

import { newId } from '@tessera/shared';
import {
  caseDetailSchema,
  caseListSchema,
  conversationSchema,
  createGroupResponseSchema,
  evidenceViewSchema,
  linkHashesSchema,
  linkPrefixesSchema,
  messageListSchema,
  standingSchema,
  transparencySchema,
  type ReportBundle,
  type StaffRole,
} from '@tessera/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runStaffCommand } from '../../cli/staff-roles.js';
import { registerDevice } from '../../test/devices.js';
import {
  TestClient,
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';

import { bundleAad, sealBundle } from './hpke.js';

/**
 * Abuse prevention and moderation (docs/moderation.md §10): blocks enforced on every path;
 * reports of end-to-end encrypted messages as sealed bundles, verified by message franking;
 * moderators reach reported evidence only, every view audited; SLA deadlines and breaches; the
 * enforcement ladder with second review; appeals to a different reviewer; grievances and legal
 * orders; link blocklist; known-abuse media; rate limits and new-account limits.
 */

let env: IntegrationApp;

beforeAll(async () => {
  env = await startIntegrationApp();
});
afterAll(async () => {
  await env.close();
});

const DAY = 24 * 3_600_000;

async function user(options: { established?: boolean } = {}) {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  const deviceId = await registerDevice(created.client, me.id);
  const privacy = (await created.client.get('/api/v1/accounts/me/privacy')).json<object>();
  await created.client.put('/api/v1/accounts/me/privacy', {
    ...privacy,
    calls: 'everyone',
    groupInvites: 'everyone',
    lastSeen: 'everyone',
  });
  // Most people here are past the first week; new-account limits are tested on their own.
  if (options.established !== false)
    await env.db
      .updateTable('users')
      .set({ created_at: new Date(Date.now() - 30 * DAY) })
      .where('id', '=', me.id)
      .execute();
  return { ...created, id: me.id, deviceId };
}
type User = Awaited<ReturnType<typeof user>>;

/** A staff member, granted through the operator command (as in production). */
async function staff(...roles: StaffRole[]): Promise<User> {
  const person = await user();
  for (const role of roles) {
    const result = await runStaffCommand(env.db, env.modules.audit, [
      'grant',
      person.username,
      role,
      '--days',
      '7',
      '--by',
      'integration-test',
    ]);
    expect(result.code, result.output).toBe(0);
  }
  return person;
}

async function stepUp(who: User): Promise<void> {
  const response = await who.client.post('/api/v1/auth/reauth/password', {
    password: who.password,
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** Signing in counts as a recent re-authentication; this ages it past the step-up window. */
async function staleSession(who: User): Promise<void> {
  await env.db
    .updateTable('sessions')
    .set({ reauthenticated_at: new Date(Date.now() - 3_600_000) })
    .where('user_id', '=', who.id)
    .execute();
}

async function direct(a: User, b: User): Promise<string> {
  const response = await a.client.post('/api/v1/conversations/direct', {
    username: b.username,
    ciphersuite: 1,
  });
  expect(response.statusCode, response.body).toBe(200);
  return conversationSchema.parse(response.json()).id;
}

/** Content as a device encrypts it: the franking key travels inside (ADR-021). */
function frankedContent(body: Record<string, unknown>): { plaintext: string; commitment: string } {
  const f = randomBytes(32);
  const plaintext = JSON.stringify({ f: f.toString('base64'), body });
  return {
    plaintext,
    commitment: createHmac('sha256', f).update(plaintext).digest('base64'),
  };
}

async function send(
  from: User,
  conversationId: string,
  options: { commitment?: string } = {},
): Promise<number> {
  const response = await from.client.post(`/api/v1/conversations/${conversationId}/messages`, {
    clientMessageId: newId(),
    senderDeviceId: from.deviceId,
    epoch: 0,
    ciphertext: randomBytes(64).toString('base64'),
    ...(options.commitment === undefined ? {} : { commitment: options.commitment }),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ seq: number }>().seq;
}

/** What the reporter's device has: the delivered envelope and the decrypted content. */
async function delivered(reporter: User, conversationId: string, seq: number) {
  const list = messageListSchema.parse(
    (await reporter.client.get(`/api/v1/conversations/${conversationId}/messages?after=0`)).json(),
  );
  const message = list.messages.find((m) => m.seq === seq);
  if (message === undefined) throw new Error(`message ${String(seq)} not delivered`);
  return message;
}

type BundleMessage = ReportBundle['messages'][number];

async function bundleMessage(
  reporter: User,
  conversationId: string,
  seq: number,
  plaintext: string,
  selected = true,
): Promise<BundleMessage> {
  const message = await delivered(reporter, conversationId, seq);
  return {
    seq,
    senderUserId: message.senderUserId,
    senderDeviceId: message.senderDeviceId,
    serverTime: message.serverTime,
    clientMessageId: message.clientMessageId,
    selected,
    plaintext,
    commitment: message.commitment,
    frankingTag: message.frankingTag,
  };
}

async function seal(
  reporter: User,
  conversationId: string,
  messages: BundleMessage[],
  media: ReportBundle['media'] = [],
  aad: { conversationId: string; reporterId: string } = { conversationId, reporterId: reporter.id },
) {
  const bundle: ReportBundle = { v: 1, conversationId, reporterId: reporter.id, messages, media };
  return sealBundle(
    env.moderationPublicKey,
    Buffer.from(JSON.stringify(bundle), 'utf8'),
    bundleAad(aad.conversationId, aad.reporterId),
  );
}

async function reportUser(reporter: User, target: User, category = 'harassment') {
  return reporter.client.post('/api/v1/reports', {
    target: { kind: 'user', userId: target.id },
    category,
  });
}

async function visiblePosts(reader: User, channelId: string): Promise<string[]> {
  const response = await reader.client.get(`/api/v1/channels/${channelId}/posts`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ posts: { id: string }[] }>().posts.map((p) => p.id);
}

async function caseFor(subjectId: string, category?: string) {
  let query = env.db
    .selectFrom('moderation_cases')
    .selectAll()
    .where('subject_id', '=', subjectId)
    .orderBy('opened_at', 'desc');
  if (category !== undefined) query = query.where('category', '=', category);
  return query.executeTakeFirstOrThrow();
}

async function auditActions(action: string): Promise<number> {
  const rows = await env.db
    .selectFrom('audit_log')
    .select('id')
    .where('action', '=', action)
    .execute();
  return rows.length;
}

describe("'moderation.block', 'moderation.unblock', 'moderation.blocks_list'", () => {
  it('blocks on every path: new chats, messages both ways, calls, group adds, presence', async () => {
    const [alice, mallory, carol] = [await user(), await user(), await user()];
    const conversationId = await direct(alice, mallory);
    await send(mallory, conversationId);

    expect((await alice.client.post('/api/v1/blocks', { userId: mallory.id })).statusCode).toBe(
      200,
    );
    expect((await alice.client.post('/api/v1/blocks', { userId: mallory.id })).statusCode).toBe(
      200,
    ); // idempotent
    expect((await alice.client.post('/api/v1/blocks', { userId: alice.id })).statusCode).toBe(400);
    expect((await alice.client.post('/api/v1/blocks', { userId: newId() })).statusCode).toBe(404);
    const list = (await alice.client.get('/api/v1/blocks')).json<{
      blocked: { userId: string; username: string }[];
    }>();
    expect(list.blocked).toEqual([
      expect.objectContaining({ userId: mallory.id, username: mallory.username }),
    ]);
    // Blocks are private: the blocked person's list is their own.
    expect((await mallory.client.get('/api/v1/blocks')).json()).toEqual({ blocked: [] });

    // Messages: refused in both directions in the existing chat.
    for (const [from] of [[mallory], [alice]] as const) {
      const refused = await from.client.post(`/api/v1/conversations/${conversationId}/messages`, {
        clientMessageId: newId(),
        senderDeviceId: from.deviceId,
        epoch: 0,
        ciphertext: randomBytes(16).toString('base64'),
      });
      expect(refused.statusCode).toBe(403);
    }
    // A new chat, either way. (Reopening the existing pair returns the same conversation, where
    // sending stays refused.)
    expect((await alice.client.post('/api/v1/blocks', { userId: carol.id })).statusCode).toBe(200);
    for (const [from, to] of [
      [carol, alice],
      [alice, carol],
    ] as const) {
      const fresh = await from.client.post('/api/v1/conversations/direct', {
        username: to.username,
        ciphersuite: 1,
      });
      expect(fresh.statusCode).toBe(403);
    }
    expect((await alice.client.delete(`/api/v1/blocks/${carol.id}`)).statusCode).toBe(200);
    // Calls.
    const call = await mallory.client.post('/api/v1/calls', {
      conversationId,
      media: 'audio',
      deviceId: mallory.deviceId,
    });
    expect(call.statusCode).toBe(403);
    // Group adds: skipped without saying why, both ways.
    const group = createGroupResponseSchema.parse(
      (
        await mallory.client.post('/api/v1/groups', {
          ciphersuite: 1,
          usernames: [alice.username, carol.username],
        })
      ).json(),
    );
    expect(group.added.map((u) => u.userId)).toEqual([carol.id]);
    expect(group.skipped).toEqual([{ username: alice.username, reason: 'not_allowed' }]);
    const aliceGroup = createGroupResponseSchema.parse(
      (
        await alice.client.post('/api/v1/groups', { ciphersuite: 1, usernames: [mallory.username] })
      ).json(),
    );
    expect(aliceGroup.skipped).toEqual([{ username: mallory.username, reason: 'not_allowed' }]);
    // Presence: hidden both ways (as if unknown).
    for (const [viewer, target] of [
      [mallory, alice],
      [alice, mallory],
    ] as const) {
      const presence = await viewer.client.get(`/api/v1/presence/${target.id}`);
      expect(presence.json()).toEqual({ userId: target.id, online: null, lastSeenAt: null });
    }
    // Carol, not blocked, still sees Alice's presence state (not hidden).
    await direct(carol, alice);
    const visible = (await carol.client.get(`/api/v1/presence/${alice.id}`)).json<{
      online: boolean | null;
    }>();
    expect(visible.online).not.toBeNull();

    // Unblock restores messaging.
    expect((await alice.client.delete(`/api/v1/blocks/${mallory.id}`)).statusCode).toBe(200);
    await send(mallory, conversationId);
    expect((await alice.client.get('/api/v1/blocks')).json()).toEqual({ blocked: [] });
  });
});

describe("'moderation.key', 'moderation.report', 'moderation.my_reports'", () => {
  it('publishes the HPKE key and suite reports are sealed with', async () => {
    const alice = await user();
    expect((await alice.client.get('/api/v1/moderation/key')).json()).toEqual({
      publicKey: env.moderationPublicKey,
      kem: 'DHKEM(P-256, HKDF-SHA256)',
      kdf: 'HKDF-SHA256',
      aead: 'AES-128-GCM',
      info: 'tessera report bundle v1',
    });
  });

  it('verifies franked messages, keeps the bundle sealed, and rejects tampering', async () => {
    const [alice, mallory] = [await user(), await user()];
    const conversationId = await direct(alice, mallory);
    const secret = 'send me the money or else, last warning';
    const content = frankedContent({ kind: 'text', text: secret });
    const seq = await send(mallory, conversationId, { commitment: content.commitment });
    const contextContent = frankedContent({ kind: 'text', text: 'hello?' });
    const contextSeq = await send(alice, conversationId, { commitment: contextContent.commitment });
    const envelope = await delivered(alice, conversationId, seq);
    expect(envelope.commitment).toBe(content.commitment);
    expect(envelope.frankingTag).toMatch(/^f1\.[A-Za-z0-9_-]{43}$/);

    const messages = [
      await bundleMessage(alice, conversationId, seq, content.plaintext),
      await bundleMessage(alice, conversationId, contextSeq, contextContent.plaintext, false),
    ];
    const response = await alice.client.post('/api/v1/reports', {
      target: {
        kind: 'conversation',
        conversationId,
        userId: mallory.id,
        seqs: [seq, contextSeq],
        bundle: await seal(alice, conversationId, messages),
      },
      category: 'harassment',
      details: 'Threats after I said no.',
    });
    expect(response.statusCode, response.body).toBe(201);
    const report = await env.db
      .selectFrom('moderation_reports')
      .selectAll()
      .where('id', '=', response.json<{ id: string }>().id)
      .executeTakeFirstOrThrow();
    expect(report.verification).toBe('content_verified');
    expect(report.target_id).toBe(mallory.id);
    const evidence = await env.db
      .selectFrom('moderation_evidence')
      .selectAll()
      .where('id', '=', report.evidence_id ?? '')
      .executeTakeFirstOrThrow();
    // Stored as received: HPKE ciphertext, hashed for chain of custody; no plaintext anywhere.
    expect(evidence.kind).toBe('e2ee_bundle');
    expect(evidence.sha256).toEqual(createHash('sha256').update(evidence.sealed).digest());
    expect(evidence.sealed.includes(Buffer.from(secret))).toBe(false);
    const caseRow = await caseFor(mallory.id, 'harassment');
    const events = await env.db
      .selectFrom('moderation_case_events')
      .select('payload')
      .where('case_id', '=', caseRow.id)
      .execute();
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(env.logs.lines.join('\n')).not.toContain(secret);

    // The reporter sees their report, not the outcome's details.
    expect(
      (await alice.client.get('/api/v1/reports')).json<{ reports: unknown[] }>().reports,
    ).toEqual([
      expect.objectContaining({
        targetKind: 'conversation',
        category: 'harassment',
        status: 'received',
      }),
    ]);
    // Reporting the same thing again is refused.
    const again = await alice.client.post('/api/v1/reports', {
      target: {
        kind: 'conversation',
        conversationId,
        seqs: [seq],
        bundle: await seal(alice, conversationId, [messages[0]!]),
      },
      category: 'harassment',
    });
    expect(again.statusCode).toBe(409);

    // Altered plaintext: accepted, but unverified (the commitment does not open to it).
    const carol = await user();
    const groupConversation = await direct(carol, mallory);
    const real = frankedContent({ kind: 'text', text: 'see you tomorrow' });
    const seq2 = await send(mallory, groupConversation, { commitment: real.commitment });
    const forged = {
      ...(await bundleMessage(carol, groupConversation, seq2, real.plaintext)),
      plaintext: real.plaintext.replace('see you tomorrow', 'i will hurt you'),
    };
    const tampered = await carol.client.post('/api/v1/reports', {
      target: {
        kind: 'conversation',
        conversationId: groupConversation,
        seqs: [seq2],
        bundle: await seal(carol, groupConversation, [forged]),
      },
      category: 'violence_threat',
    });
    expect(tampered.statusCode, tampered.body).toBe(201);
    expect(
      (
        await env.db
          .selectFrom('moderation_reports')
          .select('verification')
          .where('id', '=', tampered.json<{ id: string }>().id)
          .executeTakeFirstOrThrow()
      ).verification,
    ).toBe('unverified');
    // A forged tag or a moved message (another seq) does not verify either.
    const wrongTag = {
      ...(await bundleMessage(carol, groupConversation, seq2, real.plaintext)),
      frankingTag: `f1.${randomBytes(32).toString('base64url')}`,
    };
    const forgedTag = await carol.client.post('/api/v1/reports', {
      target: {
        kind: 'conversation',
        conversationId: groupConversation,
        seqs: [seq2],
        bundle: await seal(carol, groupConversation, [wrongTag]),
      },
      category: 'spam',
    });
    expect(forgedTag.statusCode).toBe(201);
    expect(
      (
        await env.db
          .selectFrom('moderation_reports')
          .select('verification')
          .where('id', '=', forgedTag.json<{ id: string }>().id)
          .executeTakeFirstOrThrow()
      ).verification,
    ).toBe('unverified');
  });

  it('refuses bundles for another conversation, reporter or message set, and non-members', async () => {
    const [alice, mallory, eve] = [await user(), await user(), await user()];
    const conversationId = await direct(alice, mallory);
    const other = await direct(alice, eve);
    const content = frankedContent({ kind: 'text', text: 'hi' });
    const seq = await send(mallory, conversationId, { commitment: content.commitment });
    const message = await bundleMessage(alice, conversationId, seq, content.plaintext);
    const attempt = async (who: User, target: Record<string, unknown>) =>
      who.client.post('/api/v1/reports', {
        target: { kind: 'conversation', ...target },
        category: 'spam',
      });
    // Sealed for another conversation (the binding in the HPKE additional data).
    expect(
      (
        await attempt(alice, {
          conversationId: other,
          seqs: [seq],
          bundle: await seal(alice, conversationId, [message]),
        })
      ).statusCode,
    ).toBe(400);
    // Bound to this conversation, but describing another one inside.
    expect(
      (
        await attempt(alice, {
          conversationId,
          seqs: [seq],
          bundle: await seal(alice, other, [message], [], {
            conversationId,
            reporterId: alice.id,
          }),
        })
      ).statusCode,
    ).toBe(400);
    // Sealed by someone else.
    expect(
      (
        await attempt(alice, {
          conversationId,
          seqs: [seq],
          bundle: await seal(alice, conversationId, [message], [], {
            conversationId,
            reporterId: eve.id,
          }),
        })
      ).statusCode,
    ).toBe(400);
    // Declared messages differ from those inside.
    expect(
      (
        await attempt(alice, {
          conversationId,
          seqs: [seq, seq + 1],
          bundle: await seal(alice, conversationId, [message]),
        })
      ).statusCode,
    ).toBe(400);
    // Garbage ciphertext.
    expect(
      (
        await attempt(alice, {
          conversationId,
          seqs: [seq],
          bundle: { enc: randomBytes(65).toString('base64url'), ciphertext: 'AAAA' },
        })
      ).statusCode,
    ).toBe(400);
    // Not a member: indistinguishable from an unknown conversation.
    expect((await attempt(eve, { conversationId, seqs: [], bundle: null })).statusCode).toBe(404);
    expect(
      (await attempt(eve, { conversationId: newId(), seqs: [], bundle: null })).statusCode,
    ).toBe(404);
    // Yourself.
    expect((await reportUser(alice, alice)).statusCode).toBe(400);
  });

  it('captures public content as the reporter sees it, and refuses what they cannot see', async () => {
    const [owner, reader, outsider] = [await user(), await user(), await user()];
    const created = await owner.client.post('/api/v1/channels', {
      handle: `mod_${randomBytes(4).toString('hex')}`,
      title: 'Deals',
      description: '',
      visibility: 'private',
      commentsEnabled: true,
      slowModeSeconds: 0,
    });
    expect(created.statusCode, created.body).toBe(201);
    const channelId = created.json<{ id: string }>().id;
    const post = await owner.client.post(`/api/v1/channels/${channelId}/posts`, {
      body: 'Win a free phone, send your bank PIN',
      previewUrl: null,
      poll: null,
      publish: 'now',
    });
    expect(post.statusCode, post.body).toBe(201);
    const postId = post.json<{ id: string }>().id;
    expect(await visiblePosts(owner, channelId)).toEqual([postId]);
    // The outsider is not subscribed to the private channel: no oracle, nothing captured.
    const refused = await outsider.client.post('/api/v1/reports', {
      target: { kind: 'post', channelId, postId },
      category: 'scam',
    });
    expect(refused.statusCode).toBe(404);
    const link = await owner.client.post(`/api/v1/channels/${channelId}/links`, {
      expiresInHours: 24,
      maxUses: null,
    });
    expect(link.statusCode, link.body).toBe(201);
    const token = link.json<{ token: string }>().token;
    expect(
      (await reader.client.post(`/api/v1/channel-invites/${token}/subscription`, {})).statusCode,
    ).toBe(200);
    const report = await reader.client.post('/api/v1/reports', {
      target: { kind: 'post', channelId, postId },
      category: 'scam',
    });
    expect(report.statusCode, report.body).toBe(201);
    const row = await env.db
      .selectFrom('moderation_reports')
      .selectAll()
      .where('id', '=', report.json<{ id: string }>().id)
      .executeTakeFirstOrThrow();
    expect(row.verification).toBe('server_content');
    const caseRow = await caseFor(postId);
    expect(caseRow).toMatchObject({
      subject_kind: 'post',
      subject_parent_id: channelId,
      subject_user_id: owner.id,
    });

    // A moderator removes the post; it disappears for readers; reverting restores it.
    const moderator = await staff('moderator');
    const senior = await staff('senior_moderator');
    const action = await moderator.client.post(`/api/v1/moderation/cases/${caseRow.id}/actions`, {
      action: 'remove_content',
      reasonCode: 'scam',
      note: 'Phishing for bank details',
    });
    expect(action.statusCode, action.body).toBe(201);
    expect(await visiblePosts(reader, channelId)).toEqual([]);
    await stepUp(senior);
    const revert = await senior.client.post(
      `/api/v1/moderation/actions/${action.json<{ id: string }>().id}/revert`,
      { note: 'Wrong post' },
    );
    expect(revert.statusCode, revert.body).toBe(200);
    expect(await visiblePosts(reader, channelId)).toEqual([postId]);

    // Suspending the channel hides it from readers and stops posting; admins still see it.
    const suspend = await moderator.client.post(`/api/v1/moderation/cases/${caseRow.id}/actions`, {
      action: 'channel_suspend',
      reasonCode: 'scam',
    });
    expect(suspend.statusCode, suspend.body).toBe(201);
    expect((await reader.client.get(`/api/v1/channels/${channelId}`)).statusCode).toBe(404);
    expect((await owner.client.get(`/api/v1/channels/${channelId}`)).statusCode).toBe(200);
    const blockedPost = await owner.client.post(`/api/v1/channels/${channelId}/posts`, {
      body: 'still here',
      previewUrl: null,
      poll: null,
      publish: 'now',
    });
    expect(blockedPost.statusCode).toBe(403);
  });
});

describe("'moderation.queue', 'moderation.case', 'moderation.evidence_view', 'moderation.staff_me'", () => {
  it('lets moderators reach reported evidence only, and records every view', async () => {
    const [alice, mallory, bystander] = [await user(), await user(), await user()];
    const moderator = await staff('moderator');
    expect((await moderator.client.get('/api/v1/moderation/me')).json()).toEqual({
      roles: ['moderator'],
    });
    expect((await alice.client.get('/api/v1/moderation/me')).json()).toEqual({ roles: [] });
    // Everyone else is kept out of every staff route.
    for (const url of [
      '/api/v1/moderation/cases',
      '/api/v1/moderation/appeals',
      '/api/v1/moderation/link-blocklist',
      `/api/v1/moderation/cases/${newId()}`,
    ])
      expect((await alice.client.get(url)).statusCode, url).toBe(403);

    const conversationId = await direct(alice, mallory);
    const reported = frankedContent({ kind: 'text', text: 'the reported message' });
    const seq = await send(mallory, conversationId, { commitment: reported.commitment });
    // Not reported: the moderator never gets this one, by any route.
    await send(mallory, conversationId, {
      commitment: frankedContent({ kind: 'text', text: 'never reported' }).commitment,
    });
    const report = await alice.client.post('/api/v1/reports', {
      target: {
        kind: 'conversation',
        conversationId,
        seqs: [seq],
        bundle: await seal(alice, conversationId, [
          await bundleMessage(alice, conversationId, seq, reported.plaintext),
        ]),
      },
      category: 'hate',
    });
    expect(report.statusCode, report.body).toBe(201);

    const queue = caseListSchema.parse(
      (await moderator.client.get('/api/v1/moderation/cases?status=open&category=hate')).json(),
    );
    const summary = queue.cases.find((c) => c.subjectId === mallory.id);
    expect(summary).toMatchObject({ subjectKind: 'user', subjectLabel: `@${mallory.username}` });
    const detail = caseDetailSchema.parse(
      (await moderator.client.get(`/api/v1/moderation/cases/${summary?.id ?? ''}`)).json(),
    );
    expect(detail.reports).toEqual([
      expect.objectContaining({ reporter: `@${alice.username}`, verification: 'content_verified' }),
    ]);
    const evidenceId = detail.evidence[0]?.id ?? '';
    // The case lists sealed evidence; opening it is a separate, recorded step.
    expect(JSON.stringify(detail)).not.toContain('the reported message');
    const view = evidenceViewSchema.parse(
      (
        await moderator.client.post(
          `/api/v1/moderation/cases/${detail.id}/evidence/${evidenceId}/view`,
          {},
        )
      ).json(),
    );
    if (view.kind !== 'e2ee_bundle') throw new Error('expected a bundle');
    expect(view.bundle.messages.map((m) => m.plaintext)).toEqual([reported.plaintext]);
    expect(JSON.stringify(view)).not.toContain('never reported');
    const events = await env.db
      .selectFrom('moderation_case_events')
      .select(['kind', 'actor_id'])
      .where('case_id', '=', detail.id)
      .where('kind', '=', 'evidence_viewed')
      .execute();
    expect(events).toEqual([{ kind: 'evidence_viewed', actor_id: moderator.id }]);
    const audit = await env.db
      .selectFrom('audit_log')
      .select(['actor_id', 'target_id'])
      .where('action', '=', 'moderation.evidence_viewed')
      .where('target_id', '=', evidenceId)
      .execute();
    expect(audit).toEqual([{ actor_id: moderator.id, target_id: evidenceId }]);

    // Evidence through another case's id, or the conversation itself: nothing.
    const otherCase = await reportUser(bystander, alice, 'spam');
    expect(otherCase.statusCode).toBe(201);
    const other = await caseFor(alice.id, 'spam');
    expect(
      (
        await moderator.client.post(
          `/api/v1/moderation/cases/${other.id}/evidence/${evidenceId}/view`,
          {},
        )
      ).statusCode,
    ).toBe(404);
    // Also for server-captured evidence (a public post's snapshot).
    const channel = await bystander.client.post('/api/v1/channels', {
      handle: `ev_${randomBytes(4).toString('hex')}`,
      title: 'Public',
      description: '',
      visibility: 'public',
      commentsEnabled: false,
      slowModeSeconds: 0,
    });
    const channelId = channel.json<{ id: string }>().id;
    const post = await bystander.client.post(`/api/v1/channels/${channelId}/posts`, {
      body: 'reported in public',
      previewUrl: null,
      poll: null,
      publish: 'now',
    });
    const postId = post.json<{ id: string }>().id;
    expect(
      (
        await alice.client.post('/api/v1/reports', {
          target: { kind: 'post', channelId, postId },
          category: 'hate',
        })
      ).statusCode,
    ).toBe(201);
    const snapshot = await env.db
      .selectFrom('moderation_evidence')
      .select('id')
      .where('case_id', '=', (await caseFor(postId)).id)
      .executeTakeFirstOrThrow();
    expect(
      (
        await moderator.client.post(
          `/api/v1/moderation/cases/${other.id}/evidence/${snapshot.id}/view`,
          {},
        )
      ).statusCode,
    ).toBe(404);
    const snapshotView = evidenceViewSchema.parse(
      (
        await moderator.client.post(
          `/api/v1/moderation/cases/${(await caseFor(postId)).id}/evidence/${snapshot.id}/view`,
          {},
        )
      ).json(),
    );
    expect(snapshotView).toMatchObject({
      kind: 'public_snapshot',
      snapshot: expect.objectContaining({ body: 'reported in public' }) as unknown,
    });
    expect(
      (await moderator.client.get(`/api/v1/conversations/${conversationId}/messages?after=0`))
        .statusCode,
    ).toBe(404);
  });
});

async function login(who: User): Promise<TestClient> {
  const client = new TestClient(env.app);
  const response = await client.post('/api/v1/auth/login', {
    identifier: who.username,
    password: who.password,
  });
  expect(response.statusCode, response.body).toBe(200);
  return client;
}

async function openCase(subject: User, category = 'harassment'): Promise<string> {
  const reporter = await user();
  expect((await reportUser(reporter, subject, category)).statusCode).toBe(201);
  return (await caseFor(subject.id, category)).id;
}

describe("'moderation.take_action', 'moderation.approve', 'moderation.reject', 'moderation.revert', 'moderation.standing', 'moderation.acknowledge', 'moderation.note'", () => {
  it('warns and restricts with a notice; a suspension signs out and leaves only the status page', async () => {
    const mallory = await user();
    const moderator = await staff('moderator');
    const caseId = await openCase(mallory);
    expect(
      (await moderator.client.post(`/api/v1/moderation/cases/${caseId}/acknowledge`, {}))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await moderator.client.post(`/api/v1/moderation/cases/${caseId}/notes`, {
          note: 'Second report this week',
        })
      ).statusCode,
    ).toBe(201);

    const warn = await moderator.client.post(`/api/v1/moderation/cases/${caseId}/actions`, {
      action: 'warn',
      reasonCode: 'harassment',
    });
    expect(warn.json()).toMatchObject({ status: 'active' });
    expect(env.mailer.to(mallory.email).at(-1)?.subject).toContain('You received a warning');

    // Restricting needs what and how long.
    const incomplete = await moderator.client.post(`/api/v1/moderation/cases/${caseId}/actions`, {
      action: 'restrict',
      reasonCode: 'harassment',
    });
    expect(incomplete.statusCode).toBe(400);
    const restrict = await moderator.client.post(`/api/v1/moderation/cases/${caseId}/actions`, {
      action: 'restrict',
      restriction: 'new_chats',
      durationHours: 24,
      reasonCode: 'harassment',
    });
    expect(restrict.statusCode, restrict.body).toBe(201);
    const stranger = await user();
    expect(
      (
        await mallory.client.post('/api/v1/conversations/direct', {
          username: stranger.username,
          ciphersuite: 1,
        })
      ).statusCode,
    ).toBe(403);
    // Groups still work under a new-chats restriction.
    expect(
      (await mallory.client.post('/api/v1/groups', { ciphersuite: 1, usernames: [] })).statusCode,
    ).toBe(201);
    let standing = standingSchema.parse(
      (await mallory.client.get('/api/v1/account/standing')).json(),
    );
    expect(standing.status).toBe('restricted');
    expect(standing.notices.map((n) => n.action).sort()).toEqual(['restrict', 'warn']);

    const suspend = await moderator.client.post(`/api/v1/moderation/cases/${caseId}/actions`, {
      action: 'suspend',
      durationHours: 72,
      reasonCode: 'harassment',
      note: 'Continued after warning',
    });
    expect(suspend.statusCode, suspend.body).toBe(201);
    // Signed out everywhere.
    expect((await mallory.client.get('/api/v1/accounts/me')).statusCode).toBe(401);
    const again = await login(mallory);
    for (const url of ['/api/v1/conversations', '/api/v1/channels', '/api/v1/blocks']) {
      const refused = await again.get(url);
      expect(refused.statusCode, url).toBe(403);
      expect(refused.json<{ code: string }>().code).toBe('ACCOUNT_SUSPENDED');
    }
    // What stays reachable: who am I, the status page, appeals, sessions, signing out.
    expect((await again.get('/api/v1/accounts/me')).statusCode).toBe(200);
    expect((await again.get('/api/v1/auth/sessions')).statusCode).toBe(200);
    standing = standingSchema.parse((await again.get('/api/v1/account/standing')).json());
    expect(standing.status).toBe('suspended');
    expect(standing.suspendedUntil).not.toBeNull();
    const notice = standing.notices.find((n) => n.action === 'suspend');
    expect(notice).toMatchObject({ active: true, appealable: true, reasonCode: 'harassment' });
    // The internal note is not shown to the person.
    expect(JSON.stringify(standing)).not.toContain('Continued after warning');
    expect((await again.post('/api/v1/auth/logout', {})).statusCode).toBe(200);
  });

  it('needs a second reviewer, with step-up, for bans', async () => {
    const mallory = await user();
    const moderator = await staff('moderator');
    const senior = await staff('senior_moderator');
    const otherSenior = await staff('senior_moderator');
    const caseId = await openCase(mallory, 'terrorism');
    const proposed = await senior.client.post(`/api/v1/moderation/cases/${caseId}/actions`, {
      action: 'ban',
      reasonCode: 'terrorism',
    });
    expect(proposed.json()).toMatchObject({ status: 'pending_review' });
    const actionId = proposed.json<{ id: string }>().id;
    // Not in effect yet.
    expect((await mallory.client.get('/api/v1/conversations')).statusCode).toBe(200);
    // The proposer cannot approve; a moderator cannot approve; step-up is required.
    await stepUp(senior);
    expect(
      (await senior.client.post(`/api/v1/moderation/actions/${actionId}/approve`, {})).statusCode,
    ).toBe(403);
    await stepUp(moderator);
    expect(
      (await moderator.client.post(`/api/v1/moderation/actions/${actionId}/approve`, {}))
        .statusCode,
    ).toBe(403);
    await staleSession(otherSenior);
    const noStepUp = await otherSenior.client.post(
      `/api/v1/moderation/actions/${actionId}/approve`,
      {},
    );
    expect(noStepUp.json<{ code: string }>().code).toBe('STEP_UP_REQUIRED');
    await stepUp(otherSenior);
    expect(
      (await otherSenior.client.post(`/api/v1/moderation/actions/${actionId}/approve`, {}))
        .statusCode,
    ).toBe(200);
    const again = await login(mallory);
    expect((await again.get('/api/v1/conversations')).statusCode).toBe(403);
    expect(standingSchema.parse((await again.get('/api/v1/account/standing')).json()).status).toBe(
      'banned',
    );
    const row = await env.db
      .selectFrom('moderation_actions')
      .select(['created_by', 'approved_by', 'status'])
      .where('id', '=', actionId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ created_by: senior.id, approved_by: otherSenior.id, status: 'active' });

    // A rejected proposal never takes effect.
    const other = await user();
    const otherCase = await openCase(other, 'spam');
    const second = await senior.client.post(`/api/v1/moderation/cases/${otherCase}/actions`, {
      action: 'ban',
      reasonCode: 'spam',
    });
    const secondId = second.json<{ id: string }>().id;
    expect(
      (
        await otherSenior.client.post(`/api/v1/moderation/actions/${secondId}/reject`, {
          note: 'Too severe for a first offence',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await otherSenior.client.post(`/api/v1/moderation/actions/${secondId}/approve`, {}))
        .statusCode,
    ).toBe(409);
    expect((await other.client.get('/api/v1/conversations')).statusCode).toBe(200);
  });
});

describe("'moderation.appeal', 'moderation.appeals', 'moderation.decide_appeal'", () => {
  it('takes appeals while suspended and has them decided by someone else', async () => {
    const mallory = await user();
    const moderator = await staff('moderator');
    const reviewer = await staff('moderator');
    const caseId = await openCase(mallory, 'impersonation');
    const suspend = await moderator.client.post(`/api/v1/moderation/cases/${caseId}/actions`, {
      action: 'suspend',
      durationHours: 24 * 7,
      reasonCode: 'impersonation',
    });
    const actionId = suspend.json<{ id: string }>().id;
    const client = await login(mallory);
    const appeal = await client.post('/api/v1/account/appeals', {
      actionId,
      statement: 'That is my own name; I can verify it.',
    });
    expect(appeal.statusCode, appeal.body).toBe(201);
    expect(
      (await client.post('/api/v1/account/appeals', { actionId, statement: 'again' })).statusCode,
    ).toBe(409);
    // Someone else's decision cannot be appealed by Mallory.
    const bystander = await user();
    expect(
      (
        await (
          await login(bystander)
        ).post('/api/v1/account/appeals', {
          actionId,
          statement: 'not mine',
        })
      ).statusCode,
    ).toBe(404);

    const list = (await reviewer.client.get('/api/v1/moderation/appeals')).json<{
      appeals: { id: string; user: string; statement: string }[];
    }>();
    const entry = list.appeals.find((a) => a.user === `@${mallory.username}`);
    expect(entry?.statement).toContain('my own name');
    // The moderator who suspended cannot decide the appeal.
    expect(
      (
        await moderator.client.post(`/api/v1/moderation/appeals/${entry?.id ?? ''}/decision`, {
          outcome: 'upheld',
          reason: 'Stands',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await reviewer.client.post(`/api/v1/moderation/appeals/${entry?.id ?? ''}/decision`, {
          outcome: 'overturned',
          reason: 'Identity confirmed',
        })
      ).statusCode,
    ).toBe(200);
    expect((await client.get('/api/v1/conversations')).statusCode).toBe(200);
    const standing = standingSchema.parse((await client.get('/api/v1/account/standing')).json());
    expect(standing.status).toBe('good');
    expect(standing.notices[0]?.appeal).toMatchObject({
      status: 'overturned',
      reason: 'Identity confirmed',
    });
    expect(env.mailer.to(mallory.email).at(-1)?.subject).toContain('reversed');
  });

  it('refuses appeals after the window', async () => {
    const mallory = await user();
    const moderator = await staff('moderator');
    const caseId = await openCase(mallory, 'spam');
    const warn = await moderator.client.post(`/api/v1/moderation/cases/${caseId}/actions`, {
      action: 'warn',
      reasonCode: 'spam',
    });
    const actionId = warn.json<{ id: string }>().id;
    await env.db
      .updateTable('moderation_actions')
      .set({ created_at: new Date(Date.now() - 31 * DAY) })
      .where('id', '=', actionId)
      .execute();
    const late = await mallory.client.post('/api/v1/account/appeals', {
      actionId,
      statement: 'Late',
    });
    expect(late.statusCode).toBe(409);
  });
});

describe('service-level deadlines', () => {
  it('sets deadlines by category and records each breach once', async () => {
    const expectations: [string, number, number, number][] = [
      // category, priority, hours to acknowledge, hours to resolve
      ['csam', 1, 1, 24],
      ['ncii', 1, 2, 2],
      ['synthetic_media', 1, 2, 2],
      ['violence_threat', 2, 4, 24],
      ['harassment', 3, 24, 168],
      ['spam', 4, 24, 168],
    ];
    const ids: Record<string, string> = {};
    for (const [category, priority, ackHours, dueHours] of expectations) {
      const subject = await user();
      const id = await openCase(subject, category);
      ids[category] = id;
      const row = await env.db
        .selectFrom('moderation_cases')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.priority, category).toBe(priority);
      expect(row.ack_due_at.getTime() - row.opened_at.getTime(), category).toBe(
        ackHours * 3_600_000,
      );
      expect(row.due_at.getTime() - row.opened_at.getTime(), category).toBe(dueHours * 3_600_000);
    }
    const moderator = await staff('moderator');
    // Acknowledged in time: no acknowledgement breach for harassment.
    await moderator.client.post(
      `/api/v1/moderation/cases/${ids['harassment'] ?? ''}/acknowledge`,
      {},
    );

    const breachedAt = async (id: string | undefined) =>
      (
        await env.db
          .selectFrom('moderation_cases')
          .select('breached_at')
          .where('id', '=', id ?? '')
          .executeTakeFirstOrThrow()
      ).breached_at;
    const at = (hours: number) => new Date(Date.now() + hours * 3_600_000 + 60_000);
    // Just before a deadline nothing is breached; just after, exactly the expired ones are.
    await env.modules.moderation.sweep(new Date(Date.now() + 3_600_000 - 60_000));
    expect(await breachedAt(ids['csam'])).toBeNull();
    await env.modules.moderation.sweep(at(1));
    expect(await breachedAt(ids['csam'])).not.toBeNull();
    expect(await breachedAt(ids['ncii'])).toBeNull();
    await env.modules.moderation.sweep(at(2));
    expect(await breachedAt(ids['ncii'])).not.toBeNull();
    expect(await breachedAt(ids['violence_threat'])).toBeNull();
    await env.modules.moderation.sweep(at(24));
    expect(await breachedAt(ids['violence_threat'])).not.toBeNull();
    expect(await breachedAt(ids['spam'])).not.toBeNull(); // not acknowledged within 24 h
    expect(await breachedAt(ids['harassment'])).toBeNull(); // acknowledged; due in 7 days
    await env.modules.moderation.sweep(at(169));
    expect(await breachedAt(ids['harassment'])).not.toBeNull();
    // Once per case, however often the sweep runs; visible in the queue.
    await env.modules.moderation.sweep(at(200));
    const events = await env.db
      .selectFrom('moderation_case_events')
      .select('id')
      .where('case_id', '=', ids['csam'] ?? '')
      .where('kind', '=', 'sla_breached')
      .execute();
    expect(events).toHaveLength(1);
    const queue = caseListSchema.parse(
      (await moderator.client.get('/api/v1/moderation/cases?category=csam')).json(),
    );
    expect(queue.cases.find((c) => c.id === ids['csam'])?.breached).toBe(true);
    // Most urgent first.
    const all = caseListSchema.parse(
      (await moderator.client.get('/api/v1/moderation/cases')).json(),
    );
    const priorities = all.cases.map((c) => c.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });
});

describe("'moderation.grievance', 'moderation.legal_order', 'moderation.dismiss', 'moderation.transparency'", () => {
  it('takes grievances from anyone, acknowledges them by email and reports the outcome', async () => {
    const anonymous = new TestClient(env.app);
    const response = await anonymous.post('/api/v1/grievances', {
      kind: 'ncii',
      contact: 'complainant@example.test',
      description: 'A private photo of me is being shared in a channel.',
      reference: 'https://app.tessera.test/c/some-channel',
    });
    expect(response.statusCode, response.body).toBe(201);
    const receipt = response.json<{ id: string; acknowledgeBy: string; resolveBy: string }>();
    expect(new Date(receipt.resolveBy).getTime() - Date.now()).toBeLessThanOrEqual(2 * 3_600_000);
    const mail = env.mailer.to('complainant@example.test').at(-1);
    expect(mail?.text).toContain(receipt.id);
    expect(mail?.text).toContain('Grievance Appellate Committee');
    const caseRow = await env.db
      .selectFrom('moderation_cases')
      .selectAll()
      .where('subject_id', '=', receipt.id)
      .executeTakeFirstOrThrow();
    expect(caseRow).toMatchObject({ source: 'grievance', category: 'ncii', priority: 1 });

    const moderator = await staff('moderator');
    const dismissed = await moderator.client.post(
      `/api/v1/moderation/cases/${caseRow.id}/dismiss`,
      {
        reasonCode: 'insufficient_evidence',
      },
    );
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(env.mailer.to('complainant@example.test').at(-1)?.text).toContain('found no violation');
    expect(
      (
        await moderator.client.post(`/api/v1/moderation/cases/${caseRow.id}/dismiss`, {
          reasonCode: 'duplicate',
        })
      ).statusCode,
    ).toBe(409);

    // One address cannot flood the form.
    const flooder = new TestClient(env.app);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1)
      statuses.push(
        (
          await flooder.post('/api/v1/grievances', {
            kind: 'grievance',
            contact: 'flood@example.test',
            description: `Complaint number ${String(i)} about nothing`,
          })
        ).statusCode,
      );
    expect(statuses.slice(0, 3)).toEqual([201, 201, 201]);
    expect(statuses).toContain(429);
    // Rotating addresses within one IPv6 /64 does not reset the limit.
    const rotated: number[] = [];
    for (let i = 1; i <= 5; i += 1)
      rotated.push(
        (
          await new TestClient(env.app, { ip: `2001:db8:77:1::${String(i)}` }).post(
            '/api/v1/grievances',
            {
              kind: 'grievance',
              contact: 'rotate@example.test',
              description: `Rotating complaint ${String(i)} about nothing`,
            },
          )
        ).statusCode,
      );
    expect(rotated.slice(0, 3)).toEqual([201, 201, 201]);
    expect(rotated.at(-1)).toBe(429);
  });

  it('records legal orders for the legal team only, with a 3-hour deadline and legal hold', async () => {
    const target = await user();
    const moderator = await staff('moderator', 'senior_moderator');
    const legal = await staff('legal');
    const order = {
      kind: 'court_order',
      reference: 'CS(OS) 123/2026',
      description: 'Remove the account for defamation.',
      subject: { kind: 'user', id: target.id },
    };
    await stepUp(moderator);
    expect((await moderator.client.post('/api/v1/moderation/legal-orders', order)).statusCode).toBe(
      403,
    );
    await staleSession(legal);
    expect(
      (await legal.client.post('/api/v1/moderation/legal-orders', order)).json<{ code: string }>()
        .code,
    ).toBe('STEP_UP_REQUIRED');
    await stepUp(legal);
    const created = await legal.client.post('/api/v1/moderation/legal-orders', order);
    expect(created.statusCode, created.body).toBe(201);
    const row = await env.db
      .selectFrom('moderation_cases')
      .selectAll()
      .where('id', '=', created.json<{ caseId: string }>().caseId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ source: 'legal_order', legal_hold: true, priority: 1 });
    expect(row.due_at.getTime() - row.opened_at.getTime()).toBe(3 * 3_600_000);
    // Posts and comments need their channel.
    expect(
      (
        await legal.client.post('/api/v1/moderation/legal-orders', {
          ...order,
          subject: { kind: 'post', id: newId() },
        })
      ).statusCode,
    ).toBe(400);
    // A legal referral needs the legal team's approval.
    const referral = await moderator.client.post(`/api/v1/moderation/cases/${row.id}/actions`, {
      action: 'legal_referral',
      reasonCode: 'other_policy',
    });
    const referralId = referral.json<{ id: string }>().id;
    expect(
      (await moderator.client.post(`/api/v1/moderation/actions/${referralId}/approve`, {}))
        .statusCode,
    ).toBe(403);
    expect(
      (await legal.client.post(`/api/v1/moderation/actions/${referralId}/approve`, {})).statusCode,
    ).toBe(200);
  });

  it('keeps evidence for its retention period, and under legal hold for as long as needed', async () => {
    const [alice, mallory] = [await user(), await user()];
    const conversationId = await direct(alice, mallory);
    const content = frankedContent({ kind: 'text', text: 'evidence' });
    const seq = await send(mallory, conversationId, { commitment: content.commitment });
    const sealedBundle = await seal(alice, conversationId, [
      await bundleMessage(alice, conversationId, seq, content.plaintext),
    ]);
    await alice.client.post('/api/v1/reports', {
      target: { kind: 'conversation', conversationId, seqs: [seq], bundle: sealedBundle },
      category: 'scam',
    });
    const caseRow = await caseFor(mallory.id, 'scam');
    const moderator = await staff('moderator');
    await moderator.client.post(`/api/v1/moderation/cases/${caseRow.id}/dismiss`, {
      reasonCode: 'no_violation',
    });
    await env.db
      .updateTable('moderation_cases')
      .set({ resolved_at: new Date(Date.now() - 400 * DAY), legal_hold: true })
      .where('id', '=', caseRow.id)
      .execute();
    const count = async () =>
      (
        await env.db
          .selectFrom('moderation_evidence')
          .select('id')
          .where('case_id', '=', caseRow.id)
          .execute()
      ).length;
    await env.modules.moderation.sweep();
    expect(await count()).toBe(1);
    await env.db
      .updateTable('moderation_cases')
      .set({ legal_hold: false })
      .where('id', '=', caseRow.id)
      .execute();
    await env.modules.moderation.sweep();
    expect(await count()).toBe(0);
  });

  it('reports monthly counts to senior staff only', async () => {
    const moderator = await staff('moderator');
    const senior = await staff('senior_moderator');
    const month = new Date().toISOString().slice(0, 7);
    expect(
      (await moderator.client.get(`/api/v1/moderation/transparency?month=${month}`)).statusCode,
    ).toBe(403);
    const figures = transparencySchema.parse(
      (await senior.client.get(`/api/v1/moderation/transparency?month=${month}`)).json(),
    );
    expect(figures.reportsReceived).toBeGreaterThan(0);
    expect(figures.casesOpened).toBeGreaterThan(0);
    expect(figures.grievancesReceived).toBeGreaterThan(0);
    expect(figures.legalOrdersReceived).toBeGreaterThan(0);
    expect(figures.actions['suspend']).toBeGreaterThan(0);
    expect(figures.appeals.overturned).toBeGreaterThan(0);
    expect(
      (await senior.client.get('/api/v1/moderation/transparency?month=2026-13')).statusCode,
    ).toBe(400);
  });
});

describe("'moderation.blocklist', 'moderation.blocklist_add', 'moderation.blocklist_remove', 'moderation.link_prefixes', 'moderation.link_hashes'", () => {
  it('serves k-anonymous lookups and refuses harmful links in public posts', async () => {
    const moderator = await staff('moderator');
    const alice = await user();
    const host = `phish-${randomBytes(3).toString('hex')}.example`;
    expect(
      (
        await moderator.client.post('/api/v1/moderation/link-blocklist', {
          host: `WWW.${host.toUpperCase()}`,
          category: 'phishing',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await moderator.client.get('/api/v1/moderation/link-blocklist')).json<{
        entries: { host: string }[];
      }>().entries,
    ).toContainEqual(expect.objectContaining({ host }));
    // Devices fetch 4-byte prefixes, then full hashes for one prefix: the server never sees a URL.
    const digest = createHash('sha256').update(host).digest();
    const prefixes = Buffer.from(
      linkPrefixesSchema.parse((await alice.client.get('/api/v1/link-safety/prefixes')).json())
        .prefixes,
      'base64',
    );
    const found = [...Array(prefixes.length / 4).keys()].some((i) =>
      prefixes.subarray(i * 4, i * 4 + 4).equals(digest.subarray(0, 4)),
    );
    expect(found).toBe(true);
    const hashes = linkHashesSchema.parse(
      (
        await alice.client.get(
          `/api/v1/link-safety/hashes?prefix=${digest.subarray(0, 4).toString('hex')}`,
        )
      ).json(),
    );
    expect(hashes.hashes).toContainEqual({ sha256: digest.toString('hex'), category: 'phishing' });
    expect((await alice.client.get('/api/v1/link-safety/hashes?prefix=xyz')).statusCode).toBe(400);

    // Channel posts and comments with the host (or a subdomain) are refused.
    const created = await alice.client.post('/api/v1/channels', {
      handle: `links_${randomBytes(4).toString('hex')}`,
      title: 'Links',
      description: '',
      visibility: 'public',
      commentsEnabled: true,
      slowModeSeconds: 0,
    });
    const channelId = created.json<{ id: string }>().id;
    const post = (body: string) =>
      alice.client.post(`/api/v1/channels/${channelId}/posts`, {
        body,
        previewUrl: null,
        poll: null,
        publish: 'now',
      });
    expect((await post(`Free prizes at https://login.${host}/claim`)).statusCode).toBe(400);
    const ok = await post('Nothing to see at https://example.org');
    expect(ok.statusCode).toBe(201);
    const comment = await alice.client.post(
      `/api/v1/channels/${channelId}/posts/${ok.json<{ id: string }>().id}/comments`,
      { body: `see ${host}` },
    );
    expect(comment.statusCode).toBe(400);

    expect(
      (await moderator.client.delete(`/api/v1/moderation/link-blocklist/${host}`)).statusCode,
    ).toBe(200);
    expect((await post(`Back at https://${host}`)).statusCode).toBe(201);
    expect(await auditActions('moderation.link_blocked')).toBeGreaterThan(0);
    expect(await auditActions('moderation.link_unblocked')).toBeGreaterThan(0);
  });
});

describe("'moderation.abuse_hashes_import', 'moderation.abuse_hashes_count'", () => {
  it('suspends a proven sender of known abuse media and restricts the evidence to legal', async () => {
    const legal = await staff('legal');
    const moderator = await staff('moderator');
    const media = randomBytes(2048);
    const digest = createHash('sha256').update(media).digest();
    const importBody = { hashes: [digest.toString('hex')], source: 'test hash list' };
    expect(
      (await moderator.client.post('/api/v1/moderation/abuse-hashes', importBody)).statusCode,
    ).toBe(403);
    await stepUp(legal);
    const imported = await legal.client.post('/api/v1/moderation/abuse-hashes', importBody);
    expect(imported.json()).toEqual({ count: 1 });
    expect(
      (await legal.client.get('/api/v1/moderation/abuse-hashes')).json<{ count: number }>().count,
    ).toBeGreaterThan(0);
    expect((await moderator.client.get('/api/v1/moderation/abuse-hashes')).statusCode).toBe(403);

    // Unproven: the file is in the bundle, but no verified message attests it.
    const [alice, mallory] = [await user(), await user()];
    const conversationId = await direct(alice, mallory);
    const unfranked = await send(mallory, conversationId);
    const unproven = await alice.client.post('/api/v1/reports', {
      target: {
        kind: 'conversation',
        conversationId,
        seqs: [unfranked],
        bundle: await seal(
          alice,
          conversationId,
          [await bundleMessage(alice, conversationId, unfranked, '{"body":{"kind":"media"}}')],
          [{ seq: unfranked, name: 'a.jpg', mime: 'image/jpeg', data: media.toString('base64') }],
        ),
      },
      category: 'spam',
    });
    expect(unproven.statusCode, unproven.body).toBe(201);
    const unprovenCase = await caseFor(mallory.id, 'csam');
    expect(unprovenCase).toMatchObject({ legal_hold: true, priority: 1 });
    expect((await mallory.client.get('/api/v1/conversations')).statusCode).toBe(200);

    // Proven: a franked media message whose digest is the known hash.
    const [bob, eve] = [await user(), await user()];
    const conversation2 = await direct(bob, eve);
    const content = frankedContent({
      kind: 'media',
      attachment: { media: { plaintextSha256: digest.toString('base64') } },
    });
    const seq = await send(eve, conversation2, { commitment: content.commitment });
    const proven = await bob.client.post('/api/v1/reports', {
      target: {
        kind: 'conversation',
        conversationId: conversation2,
        seqs: [seq],
        bundle: await seal(bob, conversation2, [
          await bundleMessage(bob, conversation2, seq, content.plaintext),
        ]),
      },
      category: 'sexual_content',
    });
    expect(proven.statusCode, proven.body).toBe(201);
    expect((await eve.client.get('/api/v1/accounts/me')).statusCode).toBe(401);
    const eveAgain = await login(eve);
    expect((await eveAgain.get('/api/v1/conversations')).statusCode).toBe(403);
    const caseRow = await caseFor(eve.id, 'csam');
    expect(caseRow.legal_hold).toBe(true);
    const evidence = await env.db
      .selectFrom('moderation_evidence')
      .select(['id', 'csam_match'])
      .where('case_id', '=', caseRow.id)
      .executeTakeFirstOrThrow();
    expect(evidence.csam_match).toBe(true);
    const viewUrl = `/api/v1/moderation/cases/${caseRow.id}/evidence/${evidence.id}/view`;
    expect((await moderator.client.post(viewUrl, {})).statusCode).toBe(403);
    expect((await legal.client.post(viewUrl, {})).statusCode).toBe(200);
    expect(env.logs.records().some((r) => r['event'] === 'moderation.csam_match')).toBe(true);
  });
});

describe('abuse controls', () => {
  it('limits reports per person, whatever the target', async () => {
    const reporter = await user();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1)
      statuses.push((await reportUser(reporter, await user(), 'spam')).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another session from another address (a second device) shares the person's limit.
    const second = await login(reporter);
    expect(
      (
        await second.post('/api/v1/reports', {
          target: { kind: 'user', userId: (await user()).id },
          category: 'spam',
        })
      ).statusCode,
    ).toBe(429);
  });

  it('limits new accounts in their first week', async () => {
    const fresh = await user({ established: false });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1)
      statuses.push(
        (await fresh.client.post('/api/v1/groups', { ciphersuite: 1, usernames: [] })).statusCode,
      );
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    const handle = () => `new_${randomBytes(4).toString('hex')}`;
    const channel = async () =>
      (
        await fresh.client.post('/api/v1/channels', {
          handle: handle(),
          title: 'New',
          description: '',
          visibility: 'public',
          commentsEnabled: false,
          slowModeSeconds: 0,
        })
      ).statusCode;
    expect([await channel(), await channel(), await channel()]).toEqual([201, 201, 429]);
    // Established accounts have no such limits.
    const established = await user();
    for (let i = 0; i < 6; i += 1)
      expect(
        (await established.client.post('/api/v1/groups', { ciphersuite: 1, usernames: [] }))
          .statusCode,
      ).toBe(201);
  });

  it('restricts new chats automatically when several people report or block someone', async () => {
    const spammer = await user();
    for (let i = 0; i < 2; i += 1)
      expect((await reportUser(await user(), spammer, 'spam')).statusCode).toBe(201);
    const target = await user();
    expect(
      (
        await spammer.client.post('/api/v1/conversations/direct', {
          username: target.username,
          ciphersuite: 1,
        })
      ).statusCode,
    ).toBe(200);
    // The same person reporting twice is one voice; a third person tips it.
    expect((await reportUser(await user(), spammer, 'scam')).statusCode).toBe(201);
    const blocked = await spammer.client.post('/api/v1/conversations/direct', {
      username: (await user()).username,
      ciphersuite: 1,
    });
    expect(blocked.statusCode).toBe(403);
    const action = await env.db
      .selectFrom('moderation_actions')
      .selectAll()
      .where('subject_user_id', '=', spammer.id)
      .executeTakeFirstOrThrow();
    expect(action).toMatchObject({
      action: 'restrict',
      restriction: 'new_chats',
      created_by: null,
    });
    expect(action.ends_at?.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);

    // Five blocks within a day do the same.
    const annoying = await user();
    for (let i = 0; i < 5; i += 1)
      expect(
        (await (await user()).client.post('/api/v1/blocks', { userId: annoying.id })).statusCode,
      ).toBe(200);
    expect(
      (
        await annoying.client.post('/api/v1/conversations/direct', {
          username: (await user()).username,
          ciphersuite: 1,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('staff roles and audit', () => {
  it('grants roles from the command line only, always with an expiry', async () => {
    const person = await user();
    const run = (args: string[]) => runStaffCommand(env.db, env.modules.audit, args);
    expect((await run(['grant', person.username, 'moderator', '--by', 'ops'])).code).toBe(2);
    expect(
      (await run(['grant', person.username, 'moderator', '--days', '365', '--by', 'ops'])).code,
    ).toBe(2);
    expect(
      (await run(['grant', person.username, 'admin', '--days', '1', '--by', 'ops'])).code,
    ).toBe(2);
    expect((await run(['grant', person.username, 'moderator', '--days', '1'])).code).toBe(2);
    expect(
      (await run(['grant', 'nobody_here', 'moderator', '--days', '1', '--by', 'ops'])).code,
    ).toBe(1);
    expect(
      (await run(['grant', person.username, 'moderator', '--days', '1', '--by', 'ops'])).code,
    ).toBe(0);
    expect((await run(['list'])).output).toContain(`${person.username}\tmoderator\tuntil`);
    expect((await person.client.get('/api/v1/moderation/cases')).statusCode).toBe(200);
    // Expired roles grant nothing.
    await env.db
      .updateTable('staff_roles')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('user_id', '=', person.id)
      .execute();
    expect((await run(['list'])).output).toContain(`${person.username}\tmoderator\texpired`);
    expect((await run(['revoke', person.username, 'moderator', '--by', 'ops'])).code).toBe(0);
    expect(await auditActions('moderation.staff_role_granted')).toBeGreaterThan(0);
    expect(await auditActions('moderation.staff_role_revoked')).toBeGreaterThan(0);
  });

  it('records every staff decision in the tamper-evident audit log', async () => {
    for (const action of [
      'moderation.warn',
      'moderation.restrict',
      'moderation.suspend',
      'moderation.ban',
      'moderation.ban_approved',
      'moderation.remove_content',
      'moderation.remove_content_reverted',
      'moderation.channel_suspend',
      'moderation.legal_referral',
      'moderation.legal_referral_approved',
      'moderation.appeal_overturned',
      'moderation.suspend_reverted',
      'moderation.case_dismissed',
      'moderation.evidence_viewed',
      'moderation.legal_order',
      'moderation.abuse_hashes_imported',
    ])
      expect(await auditActions(action), action).toBeGreaterThan(0);
    expect(await env.modules.audit.verifyChain()).toBeNull();
  });
});
