import { randomBytes } from 'node:crypto';

import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  MAX_ATTACHMENTS,
  MEDIA_PART_BYTES,
  type mediaDownloadSchema,
  type uploadCreatedSchema,
  type uploadPartsResponseSchema,
} from '@tessera/validation';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { z } from 'zod';

import type { Database } from '../../db/schema.js';
import type { ObjectStore } from '../../platform/object-store.js';

/**
 * End-to-end encrypted attachments (docs/media.md, ADR-043). The server issues presigned URLs and
 * records metadata; it never handles blob bytes, keys, names or types.
 */

/** Messaging's view of conversation membership (the media module does not own it). */
export interface MembershipPort {
  /** The subset of `conversationIds` the user is currently a member of. */
  memberOf(userId: string, conversationIds: readonly string[]): Promise<string[]>;
}

export interface MediaLimits {
  /** Uploads in progress per account. */
  readonly maxUploading: number;
  /** Bytes uploaded per account per rolling 24 hours (FREE tier; entitlements in Phase 13). */
  readonly dailyBytes: number;
  readonly dailyUploads: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxUploading: 10,
  dailyBytes: 2 * 1024 * 1024 * 1024,
  dailyUploads: 300,
};

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Presigned upload URLs (docs/media.md §2: 15 minutes). */
const UPLOAD_URL_SECONDS = 15 * 60;
/** Presigned download URLs (5 minutes). */
const DOWNLOAD_URL_SECONDS = 5 * 60;
/** Unfinished uploads are abandoned after this long. */
const UPLOAD_WINDOW_MS = DAY_MS;
/** A finished but never-sent blob is deleted after this long. */
const UNATTACHED_MS = DAY_MS;

function partCount(size: number): number {
  return Math.max(1, Math.ceil(size / MEDIA_PART_BYTES));
}

function partLength(size: number, partNumber: number): number {
  const parts = partCount(size);
  return partNumber < parts ? MEDIA_PART_BYTES : size - (parts - 1) * MEDIA_PART_BYTES;
}

export class MediaService {
  readonly #db: Kysely<Database>;
  readonly #store: ObjectStore;
  readonly #limits: MediaLimits;
  readonly #logger: Logger;
  #membership: MembershipPort | null = null;

  constructor(
    db: Kysely<Database>,
    store: ObjectStore,
    logger: Logger,
    limits = DEFAULT_MEDIA_LIMITS,
  ) {
    this.#db = db;
    this.#store = store;
    this.#logger = logger;
    this.#limits = limits;
  }

  useMembership(membership: MembershipPort): void {
    this.#membership = membership;
  }

  async #urls(
    key: string,
    uploadId: string,
    size: number,
    partNumbers: readonly number[],
  ): Promise<z.infer<typeof uploadPartsResponseSchema>> {
    const parts = partCount(size);
    const urls = [];
    for (const partNumber of partNumbers) {
      if (partNumber > parts) throw new AppError('BAD_REQUEST', { detail: 'No such part.' });
      urls.push({
        partNumber,
        url: await this.#store.presignPart(
          key,
          uploadId,
          partNumber,
          partLength(size, partNumber),
          UPLOAD_URL_SECONDS,
        ),
      });
    }
    return {
      parts: urls,
      urlsExpireAt: new Date(Date.now() + UPLOAD_URL_SECONDS * 1000).toISOString(),
    };
  }

  /** Starts an upload of `size` ciphertext bytes; returns presigned URLs for every part. */
  async createUpload(userId: string, size: number): Promise<z.infer<typeof uploadCreatedSchema>> {
    const since = new Date(Date.now() - DAY_MS);
    const usage = await this.#db
      .selectFrom('media_blobs')
      .select((eb) => [
        eb.fn.countAll<string>().as('uploads'),
        eb.fn.coalesce(eb.fn.sum<string>('size'), sql<string>`0`).as('bytes'),
        eb.fn.count<string>('id').filterWhere('status', '=', 'uploading').as('uploading'),
      ])
      .where('owner_id', '=', userId)
      .where('created_at', '>', since)
      .executeTakeFirstOrThrow();
    if (Number(usage.uploading) >= this.#limits.maxUploading)
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many uploads in progress. Wait for them to finish.',
      });
    if (
      Number(usage.uploads) >= this.#limits.dailyUploads ||
      Number(usage.bytes) + size > this.#limits.dailyBytes
    )
      throw new AppError('RATE_LIMITED', {
        detail: 'You have reached today’s upload limit. Try again tomorrow.',
      });

    const id = newId();
    const key = `e2ee/${randomBytes(16).toString('hex')}`;
    const uploadId = await this.#store.createMultipart(key);
    const now = new Date();
    await this.#db
      .insertInto('media_blobs')
      .values({
        id,
        owner_id: userId,
        object_key: key,
        upload_id: uploadId,
        size,
        part_size: MEDIA_PART_BYTES,
        status: 'uploading',
        created_at: now,
        expires_at: new Date(now.getTime() + UPLOAD_WINDOW_MS),
      })
      .execute();
    const numbers = Array.from({ length: partCount(size) }, (_, i) => i + 1);
    return {
      blobId: id,
      partSize: MEDIA_PART_BYTES,
      ...(await this.#urls(key, uploadId, size, numbers)),
    };
  }

  async #uploading(userId: string, blobId: string) {
    const blob = await this.#db
      .selectFrom('media_blobs')
      .selectAll()
      .where('id', '=', blobId)
      .where('owner_id', '=', userId)
      .where('status', '=', 'uploading')
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    if (blob?.upload_id == null) throw new AppError('NOT_FOUND', { detail: 'No such upload.' });
    return { ...blob, upload_id: blob.upload_id };
  }

  /** Fresh URLs for parts whose URLs expired (long or resumed uploads). */
  async partUrls(
    userId: string,
    blobId: string,
    partNumbers: readonly number[],
  ): Promise<z.infer<typeof uploadPartsResponseSchema>> {
    const blob = await this.#uploading(userId, blobId);
    return this.#urls(blob.object_key, blob.upload_id, Number(blob.size), partNumbers);
  }

  async completeUpload(
    userId: string,
    blobId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<{ blobId: string }> {
    const blob = await this.#uploading(userId, blobId);
    const size = Number(blob.size);
    const expected = partCount(size);
    const numbers = parts.map((part) => part.partNumber);
    if (parts.length !== expected || numbers.some((number, index) => number !== index + 1))
      throw new AppError('BAD_REQUEST', { detail: 'Every part must be listed once, in order.' });
    try {
      await this.#store.complete(blob.object_key, blob.upload_id, parts);
    } catch {
      throw new AppError('BAD_REQUEST', {
        detail: 'The upload is incomplete; retry the missing parts.',
      });
    }
    // Presigned part URLs bind each part's length; the total is checked again here, so a
    // store that does not enforce the signature still cannot hold a different-size object.
    const stored = await this.#store.size(blob.object_key);
    if (stored !== size) {
      await this.#store.delete([blob.object_key]);
      await this.#db.deleteFrom('media_blobs').where('id', '=', blobId).execute();
      throw new AppError('BAD_REQUEST', { detail: 'The uploaded size does not match.' });
    }
    const now = new Date();
    const updated = await this.#db
      .updateTable('media_blobs')
      .set({
        status: 'ready',
        upload_id: null,
        completed_at: now,
        expires_at: new Date(now.getTime() + UNATTACHED_MS),
      })
      .where('id', '=', blobId)
      .where('status', '=', 'uploading')
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n)
      throw new AppError('CONFLICT', { detail: 'Already completed.' });
    return { blobId };
  }

  async abortUpload(userId: string, blobId: string): Promise<{ ok: true }> {
    const blob = await this.#uploading(userId, blobId);
    await this.#store.abort(blob.object_key, blob.upload_id).catch(() => undefined);
    await this.#db.deleteFrom('media_blobs').where('id', '=', blobId).execute();
    return { ok: true };
  }

  /**
   * Links attachments to a conversation as part of sending a message (same transaction). Only
   * the sender's own finished uploads can be attached; each link lives as long as the message.
   */
  async attach(
    trx: Transaction<Database>,
    input: { userId: string; conversationId: string; blobIds: readonly string[]; expiresAt: Date },
  ): Promise<void> {
    const ids = [...new Set(input.blobIds)];
    if (ids.length === 0) return;
    if (ids.length > MAX_ATTACHMENTS)
      throw new AppError('BAD_REQUEST', { detail: `At most ${MAX_ATTACHMENTS} attachments.` });
    const blobs = await trx
      .selectFrom('media_blobs')
      .select('id')
      .where('id', 'in', ids)
      .where('owner_id', '=', input.userId)
      .where('status', '=', 'ready')
      .where('expires_at', '>', new Date())
      .forUpdate()
      .execute();
    if (blobs.length !== ids.length)
      throw new AppError('BAD_REQUEST', { detail: 'An attachment is missing or has expired.' });
    await trx
      .insertInto('media_links')
      .values(
        ids.map((blobId) => ({
          blob_id: blobId,
          conversation_id: input.conversationId,
          expires_at: input.expiresAt,
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(['blob_id', 'conversation_id'])
          .doUpdateSet({ expires_at: sql`greatest(media_links.expires_at, excluded.expires_at)` }),
      )
      .execute();
    await trx
      .updateTable('media_blobs')
      .set({ expires_at: sql`greatest(expires_at, ${input.expiresAt})` })
      .where('id', 'in', ids)
      .execute();
  }

  /**
   * A short-lived download URL, for the uploader or a current member of a conversation the blob
   * was sent to (while that message has not expired).
   */
  async download(userId: string, blobId: string): Promise<z.infer<typeof mediaDownloadSchema>> {
    const now = new Date();
    const blob = await this.#db
      .selectFrom('media_blobs')
      .select(['object_key', 'size', 'owner_id'])
      .where('id', '=', blobId)
      .where('status', '=', 'ready')
      .where('expires_at', '>', now)
      .executeTakeFirst();
    // Same response whether the blob does not exist or the caller may not see it.
    const denied = new AppError('NOT_FOUND', { detail: 'No such attachment.' });
    if (blob === undefined) throw denied;
    if (blob.owner_id !== userId) {
      const links = await this.#db
        .selectFrom('media_links')
        .select('conversation_id')
        .where('blob_id', '=', blobId)
        .where('expires_at', '>', now)
        .execute();
      const membership = this.#membership;
      if (membership === null) throw new Error('media: membership port not configured');
      const allowed = await membership.memberOf(
        userId,
        links.map((link) => link.conversation_id),
      );
      if (allowed.length === 0) throw denied;
    }
    return {
      url: await this.#store.presignGet(blob.object_key, DOWNLOAD_URL_SECONDS),
      size: Number(blob.size),
      urlExpiresAt: new Date(now.getTime() + DOWNLOAD_URL_SECONDS * 1000).toISOString(),
    };
  }

  /** Deletes expired blobs and abandoned uploads (objects first, then rows). */
  async sweep(batch = 200): Promise<number> {
    let total = 0;
    for (;;) {
      const expired = await this.#db
        .selectFrom('media_blobs')
        .select(['id', 'object_key', 'upload_id'])
        .where('expires_at', '<=', new Date())
        .limit(batch)
        .execute();
      if (expired.length === 0) break;
      for (const blob of expired.filter((b) => b.upload_id !== null))
        await this.#store.abort(blob.object_key, blob.upload_id ?? '').catch(() => undefined);
      await this.#store.delete(
        expired.filter((b) => b.upload_id === null).map((b) => b.object_key),
      );
      await this.#db
        .deleteFrom('media_blobs')
        .where(
          'id',
          'in',
          expired.map((b) => b.id),
        )
        .execute();
      await this.#db.deleteFrom('media_links').where('expires_at', '<=', new Date()).execute();
      total += expired.length;
      if (expired.length < batch) break;
    }
    if (total > 0) this.#logger.info('media.sweep', { count: total });
    return total;
  }
}
