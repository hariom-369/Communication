import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NotFound,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object storage for client-encrypted blobs (docs/media.md §5). The API never handles blob bytes:
 * clients upload and download directly with short-lived presigned URLs, each bound to one object
 * key (and, for uploads, one part number and exact length).
 */
export interface ObjectStore {
  createMultipart(key: string): Promise<string>;
  /** Presigned `PUT` for one part; the signature covers `Content-Length`. */
  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
    expiresInSeconds: number,
  ): Promise<string>;
  complete(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  /** Reachability of the bucket (admin health view). */
  ping(): Promise<void>;
  /** Size in bytes, or null if the object does not exist. */
  size(key: string): Promise<number | null>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  delete(keys: readonly string[]): Promise<void>;
}

export interface S3StoreOptions {
  readonly bucket: string;
  readonly region: string;
  /** S3-compatible endpoint (MinIO, test emulator); omit for AWS. */
  readonly endpoint?: string | undefined;
  readonly forcePathStyle?: boolean;
  /** Explicit credentials (tests); production uses the default provider chain (IAM role). */
  readonly credentials?: { accessKeyId: string; secretAccessKey: string };
}

export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(options: S3StoreOptions) {
    const config: S3ClientConfig = {
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? false,
      // Only compute checksums when an operation requires them; presigned part URLs must not
      // demand checksum headers the browser does not send.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    if (options.endpoint !== undefined) config.endpoint = options.endpoint;
    if (options.credentials !== undefined) config.credentials = options.credentials;
    this.#client = new S3Client(config);
    this.#bucket = options.bucket;
  }

  get client(): S3Client {
    return this.#client;
  }

  async createMultipart(key: string): Promise<string> {
    const result = await this.#client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: key,
        ContentType: 'application/octet-stream',
      }),
    );
    if (result.UploadId === undefined) throw new Error('object store returned no upload id');
    return result.UploadId;
  }

  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.#client,
      new UploadPartCommand({
        Bucket: this.#bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
      }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-length']) },
    );
  }

  async complete(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<void> {
    await this.#client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }

  async abort(key: string, uploadId: string): Promise<void> {
    await this.#client.send(
      new AbortMultipartUploadCommand({ Bucket: this.#bucket, Key: key, UploadId: uploadId }),
    );
  }

  async ping(): Promise<void> {
    await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
  }

  async size(key: string): Promise<number | null> {
    try {
      const head = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return head.ContentLength ?? null;
    } catch (error) {
      if (error instanceof NotFound || (error as { name?: string }).name === 'NotFound')
        return null;
      throw error;
    }
  }

  presignGet(key: string, expiresInSeconds: number): Promise<string> {
    // The response headers are part of the signature: whatever metadata the object carries, the
    // browser receives an opaque download it will not render (defence in depth — objects are
    // ciphertext stored as application/octet-stream; security review F-03).
    return getSignedUrl(
      this.#client,
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        ResponseContentType: 'application/octet-stream',
        ResponseContentDisposition: 'attachment',
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}
