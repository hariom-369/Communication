import type { MediaReference } from '@tessera/validation';

import { ApiError } from '../api/client.js';
import type { endpoints as Endpoints } from '../api/endpoints.js';
import type { MediaDigest } from '../crypto/protocol.js';

/**
 * Moves encrypted attachments between this device and object storage (docs/media.md §2).
 * Encryption and decryption happen in the crypto worker; this class only sees ciphertext on the
 * network side and hands plaintext Blobs to the UI.
 *
 * Uploads go part by part to presigned URLs, with retries and fresh URLs when they expire.
 * Downloads are verified against the digest in the message and cached as ciphertext.
 */

type Api = Pick<
  typeof Endpoints,
  'createUpload' | 'uploadParts' | 'completeUpload' | 'abortUpload' | 'mediaDownload'
>;

export interface MediaCrypto {
  encryptMedia(file: Blob): Promise<{ ciphertext: Blob; digest: MediaDigest }>;
  decryptMedia(ciphertext: Blob, digest: MediaDigest, type: string): Promise<Blob>;
  cachedMedia(blobId: string): Promise<Blob | null>;
  cacheMedia(blobId: string, ciphertext: Blob): Promise<void>;
}

export interface Http {
  /** PUT `body` to `url`; resolves with the ETag. Reports bytes sent. */
  put(
    url: string,
    body: Blob,
    onProgress: (sent: number) => void,
    signal: AbortSignal,
  ): Promise<string>;
  get(url: string, signal: AbortSignal): Promise<Blob>;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`storage responded ${status}`);
    this.status = status;
  }
}

/** Browser transport: XMLHttpRequest for upload progress, fetch for downloads. */
export const browserHttp: Http = {
  put(url, body, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('PUT', url);
      request.upload.onprogress = (event) => {
        onProgress(event.loaded);
      };
      request.onload = () => {
        if (request.status >= 200 && request.status < 300)
          resolve(request.getResponseHeader('ETag') ?? '');
        else reject(new HttpError(request.status));
      };
      request.onerror = () => {
        reject(new HttpError(0));
      };
      signal.addEventListener('abort', () => {
        request.abort();
        reject(new DOMException('Upload cancelled', 'AbortError'));
      });
      request.send(body);
    });
  },
  async get(url, signal) {
    // No cookies or referrer to storage; the URL itself is the (short-lived) capability.
    const response = await fetch(url, {
      signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new HttpError(response.status);
    return response.blob();
  },
};

const PART_ATTEMPTS = 4;

export class MediaTransfer {
  readonly #api: Api;
  readonly #crypto: MediaCrypto;
  readonly #http: Http;
  readonly #opened = new Map<string, Promise<Blob>>();

  constructor(api: Api, crypto: MediaCrypto, http: Http = browserHttp) {
    this.#api = api;
    this.#crypto = crypto;
    this.#http = http;
  }

  /** Encrypts and uploads; returns what the message must carry. */
  async upload(
    file: Blob,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<MediaReference> {
    const { ciphertext, digest } = await this.#crypto.encryptMedia(file);
    const created = await this.#api.createUpload(ciphertext.size);
    const sent = new Map<number, number>();
    const report = () => {
      let total = 0;
      for (const bytes of sent.values()) total += bytes;
      onProgress(Math.min(1, total / ciphertext.size));
    };
    try {
      const urls = new Map(created.parts.map((part) => [part.partNumber, part.url]));
      const etags: { partNumber: number; etag: string }[] = [];
      for (const partNumber of [...urls.keys()].sort((a, b) => a - b)) {
        const body = ciphertext.slice(
          (partNumber - 1) * created.partSize,
          partNumber * created.partSize,
        );
        let etag: string | null = null;
        for (let attempt = 1; etag === null; attempt += 1) {
          if (signal.aborted) throw new DOMException('Upload cancelled', 'AbortError');
          try {
            etag = await this.#http.put(
              urls.get(partNumber) ?? '',
              body,
              (bytes) => {
                sent.set(partNumber, bytes);
                report();
              },
              signal,
            );
          } catch (error) {
            if (!(error instanceof HttpError) || attempt >= PART_ATTEMPTS) throw error;
            sent.set(partNumber, 0);
            // Expired or rejected URL: ask for a fresh one, then back off a little.
            if (error.status === 403) {
              const fresh = await this.#api.uploadParts(created.blobId, [partNumber]);
              for (const part of fresh.parts) urls.set(part.partNumber, part.url);
            }
            await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          }
        }
        sent.set(partNumber, body.size);
        report();
        etags.push({ partNumber, etag });
      }
      await this.#api.completeUpload(created.blobId, etags);
    } catch (error) {
      await this.#api.abortUpload(created.blobId).catch(() => undefined);
      throw error;
    }
    // Our own copy is cached too, so the sender never downloads what it just uploaded.
    await this.#crypto.cacheMedia(created.blobId, ciphertext).catch(() => undefined);
    return { blobId: created.blobId, ...digest };
  }

  /**
   * Plaintext of an attachment, verified against the message (cached ciphertext first). Errors:
   * `expired` when the server no longer has it, otherwise the underlying error.
   */
  open(reference: MediaReference, type: string, signal?: AbortSignal): Promise<Blob> {
    const key = `${reference.blobId}:${reference.ciphertextSha256}`;
    const running = this.#opened.get(key);
    if (running !== undefined) return running;
    const work = this.#open(reference, type, signal ?? new AbortController().signal);
    this.#opened.set(key, work);
    work.catch(() => this.#opened.delete(key));
    return work;
  }

  async #open(reference: MediaReference, type: string, signal: AbortSignal): Promise<Blob> {
    const { blobId, ...digest } = reference;
    let ciphertext = await this.#crypto.cachedMedia(blobId).catch(() => null);
    if (ciphertext === null) {
      let download;
      try {
        download = await this.#api.mediaDownload(blobId);
      } catch (error) {
        if (error instanceof ApiError && error.problem.status === 404)
          throw new MediaExpiredError();
        throw error;
      }
      ciphertext = await this.#http.get(download.url, signal);
      const plaintext = await this.#crypto.decryptMedia(ciphertext, digest, type);
      // Only verified ciphertext is cached.
      await this.#crypto.cacheMedia(blobId, ciphertext).catch(() => undefined);
      return plaintext;
    }
    return this.#crypto.decryptMedia(ciphertext, digest, type);
  }
}

/** The server no longer holds the attachment (expired or never shared with this account). */
export class MediaExpiredError extends Error {
  constructor() {
    super('This attachment is no longer available.');
    this.name = 'MediaExpiredError';
  }
}
