import { randomBytes } from 'node:crypto';

import { newId } from '@tessera/shared';
import { MEDIA_PART_BYTES, mediaDownloadSchema, uploadCreatedSchema } from '@tessera/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerDevice } from '../../test/devices.js';
import {
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
  type TestClient,
} from '../../test/integration-app.js';

import { MediaService } from './media.js';

/** Encrypted attachments: presigned uploads, links to conversations, authorization, expiry. */

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
  const deviceId = await registerDevice(created.client, me.id);
  return { ...created, id: me.id, deviceId };
}
type User = Awaited<ReturnType<typeof user>>;

/** Uploads `bytes` (standing in for client ciphertext) through the presigned URLs. */
async function upload(client: TestClient, bytes: Buffer): Promise<string> {
  const created = await client.post('/api/v1/media/uploads', { size: bytes.length });
  expect(created.statusCode, created.body).toBe(201);
  const { blobId, parts, partSize } = uploadCreatedSchema.parse(created.json());
  const etags = [];
  for (const part of parts) {
    const body = bytes.subarray((part.partNumber - 1) * partSize, part.partNumber * partSize);
    const response = await fetch(part.url, { method: 'PUT', body });
    expect(response.status).toBe(200);
    etags.push({ partNumber: part.partNumber, etag: response.headers.get('etag') ?? '' });
  }
  const done = await client.post(`/api/v1/media/uploads/${blobId}/complete`, { parts: etags });
  expect(done.statusCode, done.body).toBe(200);
  return blobId;
}

async function fetchBlob(client: TestClient, blobId: string) {
  const response = await client.get(`/api/v1/media/${blobId}`);
  if (response.statusCode !== 200) return { status: response.statusCode, bytes: null };
  const { url } = mediaDownloadSchema.parse(response.json());
  return { status: 200, bytes: Buffer.from(await (await fetch(url)).arrayBuffer()) };
}

async function conversationWith(a: User, b: User): Promise<string> {
  const response = await a.client.post('/api/v1/conversations/direct', {
    username: b.username,
    ciphersuite: 1,
  });
  return response.json<{ id: string }>().id;
}

function send(from: User, conversationId: string, attachments?: string[]) {
  return from.client.post(`/api/v1/conversations/${conversationId}/messages`, {
    clientMessageId: newId(),
    senderDeviceId: from.deviceId,
    epoch: 0,
    ciphertext: randomBytes(64).toString('base64'),
    ...(attachments === undefined ? {} : { attachments }),
  });
}

describe("'media.create_upload', 'media.upload_parts', 'media.complete_upload', 'media.abort_upload'", () => {
  it('uploads multi-part ciphertext directly to storage with short-lived, length-bound URLs', async () => {
    const alice = await user();
    const bytes = randomBytes(MEDIA_PART_BYTES + 12_345);
    const created = uploadCreatedSchema.parse(
      (await alice.client.post('/api/v1/media/uploads', { size: bytes.length })).json(),
    );
    expect(created.parts.map((p) => p.partNumber)).toEqual([1, 2]);
    for (const part of created.parts) {
      const url = new URL(part.url);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
      // Object keys are random, never derived from anything the client sent.
      expect(url.pathname).toMatch(/\/e2ee\/[0-9a-f]{32}$/);
    }
    // Fresh URLs for a resumed upload; parts that do not exist are refused.
    const refreshed = await alice.client.post(`/api/v1/media/uploads/${created.blobId}/parts`, {
      partNumbers: [2],
    });
    expect(refreshed.json<{ parts: unknown[] }>().parts).toHaveLength(1);
    expect(
      (
        await alice.client.post(`/api/v1/media/uploads/${created.blobId}/parts`, {
          partNumbers: [3],
        })
      ).statusCode,
    ).toBe(400);
    // Another account cannot touch the upload.
    const bob = await user();
    expect(
      (
        await bob.client.post(`/api/v1/media/uploads/${created.blobId}/parts`, {
          partNumbers: [1],
        })
      ).statusCode,
    ).toBe(404);
    // Cancelling removes the upload; it cannot be resumed or completed afterwards.
    expect((await bob.client.delete(`/api/v1/media/uploads/${created.blobId}`)).statusCode).toBe(
      404,
    );
    expect((await alice.client.delete(`/api/v1/media/uploads/${created.blobId}`)).statusCode).toBe(
      200,
    );
    expect(
      (
        await alice.client.post(`/api/v1/media/uploads/${created.blobId}/parts`, {
          partNumbers: [1],
        })
      ).statusCode,
    ).toBe(404);

    const blobId = await upload(alice.client, bytes);
    expect((await fetchBlob(alice.client, blobId)).bytes?.equals(bytes)).toBe(true);
    // Completing twice is refused.
    expect(
      (await alice.client.post(`/api/v1/media/uploads/${blobId}/complete`, { parts: [] }))
        .statusCode,
    ).toBe(400);
    const row = await env.db
      .selectFrom('media_blobs')
      .selectAll()
      .where('id', '=', blobId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ready');
    // Unattached: kept for a day only.
    expect(row.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('refuses incomplete uploads, parts out of order and objects of the wrong size', async () => {
    const alice = await user();
    const bytes = randomBytes(MEDIA_PART_BYTES + 10);
    const created = uploadCreatedSchema.parse(
      (await alice.client.post('/api/v1/media/uploads', { size: bytes.length })).json(),
    );
    const [first, second] = created.parts;
    const put = async (url: string, body: Buffer) =>
      (await fetch(url, { method: 'PUT', body })).headers.get('etag') ?? '';
    const etag1 = await put(first!.url, bytes.subarray(0, MEDIA_PART_BYTES));
    const complete = (parts: { partNumber: number; etag: string }[]) =>
      alice.client.post(`/api/v1/media/uploads/${created.blobId}/complete`, { parts });
    expect((await complete([{ partNumber: 1, etag: etag1 }])).statusCode).toBe(400);
    // The second part is shorter than declared (a store enforcing the signed length would
    // already refuse the PUT; the size check at completion catches it regardless).
    const etag2 = await put(second!.url, Buffer.from('x'));
    expect(
      (
        await complete([
          { partNumber: 2, etag: etag2 },
          { partNumber: 1, etag: etag1 },
        ])
      ).statusCode,
    ).toBe(400);
    const wrong = await complete([
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);
    expect(wrong.json()).toMatchObject({ detail: 'The uploaded size does not match.' });
    expect(
      await env.db
        .selectFrom('media_blobs')
        .select('id')
        .where('id', '=', created.blobId)
        .execute(),
    ).toEqual([]);
    // Sizes beyond the account's plan (200 MB free) are rejected before anything is stored;
    // sizes beyond any plan fail validation.
    const overPlan = await alice.client.post('/api/v1/media/uploads', { size: 300 * 1024 * 1024 });
    expect(overPlan.statusCode).toBe(413);
    expect(overPlan.json<{ detail: string }>().detail).toMatch(/200 MB on your plan/);
    expect(
      (await alice.client.post('/api/v1/media/uploads', { size: 2 * 1024 * 1024 * 1024 }))
        .statusCode,
    ).toBe(400);
  });
});

describe("'media.download' and attachments on 'messaging.send'", () => {
  it('lets members of the conversation a blob was sent to download it, and nobody else', async () => {
    const alice = await user();
    const bob = await user();
    const carol = await user();
    const conversation = await conversationWith(alice, bob);
    const bytes = randomBytes(1000);
    const blobId = await upload(alice.client, bytes);

    // Before it is sent, only the uploader can fetch it.
    expect((await fetchBlob(bob.client, blobId)).status).toBe(404);
    const sent = await send(alice, conversation, [blobId]);
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await fetchBlob(bob.client, blobId)).bytes?.equals(bytes)).toBe(true);
    // Whatever the object's metadata, the download is an opaque attachment the browser will not
    // render as a page (the response headers are part of the signed URL).
    const { url } = mediaDownloadSchema.parse(
      (await bob.client.get(`/api/v1/media/${blobId}`)).json(),
    );
    const download = await fetch(url);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('content-disposition')).toBe('attachment');
    await download.arrayBuffer();
    // Not a member: same answer as for a blob that does not exist.
    const outsider = await carol.client.get(`/api/v1/media/${blobId}`);
    const missing = await carol.client.get(`/api/v1/media/${newId()}`);
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json<{ detail: string }>().detail).toBe(
      missing.json<{ detail: string }>().detail,
    );

    // The link lives as long as the message; the blob's expiry follows the longest link.
    const link = await env.db
      .selectFrom('media_links')
      .selectAll()
      .where('blob_id', '=', blobId)
      .executeTakeFirstOrThrow();
    const blob = await env.db
      .selectFrom('media_blobs')
      .select('expires_at')
      .where('id', '=', blobId)
      .executeTakeFirstOrThrow();
    expect(link.conversation_id).toBe(conversation);
    expect(blob.expires_at.getTime()).toBe(link.expires_at.getTime());
    expect(link.expires_at.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 3_600_000);

    // When the message expires, members lose access.
    await env.db
      .updateTable('media_links')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('blob_id', '=', blobId)
      .execute();
    expect((await fetchBlob(bob.client, blobId)).status).toBe(404);
  });

  it('only attaches the sender’s own finished uploads, atomically with the message', async () => {
    const alice = await user();
    const bob = await user();
    const conversation = await conversationWith(alice, bob);
    const alicesBlob = await upload(alice.client, randomBytes(100));
    // Bob cannot attach (and so share) Alice's blob.
    expect((await send(bob, conversation, [alicesBlob])).statusCode).toBe(400);
    // An unfinished upload or an unknown id is refused, and no message is stored.
    const unfinished = uploadCreatedSchema.parse(
      (await alice.client.post('/api/v1/media/uploads', { size: 100 })).json(),
    );
    const before = await env.db
      .selectFrom('mailbox_messages')
      .select('seq')
      .where('conversation_id', '=', conversation)
      .execute();
    for (const ids of [[unfinished.blobId], [newId()], [alicesBlob, newId()]]) {
      expect((await send(alice, conversation, ids)).statusCode).toBe(400);
    }
    const after = await env.db
      .selectFrom('mailbox_messages')
      .select('seq')
      .where('conversation_id', '=', conversation)
      .execute();
    expect(after).toEqual(before);
    expect(
      await env.db
        .selectFrom('media_links')
        .select('blob_id')
        .where('blob_id', '=', alicesBlob)
        .execute(),
    ).toEqual([]);
    // At most 10 per message (schema).
    expect(
      (
        await send(
          alice,
          conversation,
          Array.from({ length: 11 }, () => newId()),
        )
      ).statusCode,
    ).toBe(400);
    expect((await send(alice, conversation, [alicesBlob, alicesBlob])).statusCode).toBe(201);
  });
});

describe('part list validation', () => {
  it('never asks storage to assemble a part list that is incomplete, repeated or out of order', async () => {
    const alice = await user();
    const completions: unknown[] = [];
    const store = new Proxy(env.media, {
      get(target, property, receiver) {
        if (property === 'complete')
          return (...args: unknown[]) => {
            completions.push(args);
            return Promise.resolve();
          };
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const media = new MediaService(env.db, store, env.logger);
    const { blobId } = await media.createUpload(alice.id, MEDIA_PART_BYTES * 2 + 1);
    for (const numbers of [
      [1, 2],
      [1, 1, 2],
      [2, 1, 3],
      [1, 2, 4],
    ]) {
      await expect(
        media.completeUpload(
          alice.id,
          blobId,
          numbers.map((partNumber) => ({ partNumber, etag: 'e' })),
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(completions).toEqual([]);
  });
});

describe('limits and expiry', () => {
  it('limits uploads in progress and daily volume per account', async () => {
    const alice = await user();
    const media = new MediaService(env.db, env.media, env.logger, {
      maxUploading: 2,
      dailyBytes: 1000,
      dailyUploads: 3,
      maxFileBytes: 200 * 1024 * 1024,
    });
    await media.createUpload(alice.id, 100);
    await media.createUpload(alice.id, 100);
    await expect(media.createUpload(alice.id, 100)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await env.db
      .updateTable('media_blobs')
      .set({ status: 'ready', upload_id: null })
      .where('owner_id', '=', alice.id)
      .execute();
    await expect(media.createUpload(alice.id, 900)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await media.createUpload(alice.id, 100);
    await env.db
      .updateTable('media_blobs')
      .set({ status: 'ready', upload_id: null })
      .where('owner_id', '=', alice.id)
      .execute();
    await expect(media.createUpload(alice.id, 10)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('deletes expired blobs from storage and abandons stale uploads', async () => {
    const alice = await user();
    const kept = await upload(alice.client, randomBytes(50));
    const expired = await upload(alice.client, randomBytes(50));
    const stale = uploadCreatedSchema.parse(
      (await alice.client.post('/api/v1/media/uploads', { size: 50 })).json(),
    );
    const keyOf = async (id: string) =>
      (
        await env.db
          .selectFrom('media_blobs')
          .select('object_key')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).object_key;
    const expiredKey = await keyOf(expired);
    await env.db
      .updateTable('media_blobs')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', 'in', [expired, stale.blobId])
      .execute();
    expect(await env.media.size(expiredKey)).toBe(50);
    expect(await env.modules.media.sweep()).toBeGreaterThanOrEqual(2);
    expect(await env.media.size(expiredKey)).toBeNull();
    const left = await env.db
      .selectFrom('media_blobs')
      .select('id')
      .where('owner_id', '=', alice.id)
      .execute();
    expect(left.map((row) => row.id)).toEqual([kept]);
    expect(env.logs.lines.join('\n')).toContain('media.sweep');
  });
});
