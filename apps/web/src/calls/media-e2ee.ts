import { startWorker } from '../lib/worker-policy.js';

import type { FrameKind } from './frame-crypto.js';
import type { MediaWorkerMessage, MediaWorkerStats } from './media-worker.js';
import workerUrl from './media-worker.ts?worker&url';

declare const RTCRtpScriptTransform:
  | (new (worker: Worker, options: { side: 'send' | 'receive'; kind: FrameKind }) => object)
  | undefined;

interface EncodedStreams {
  readonly readable: ReadableStream;
  readonly writable: WritableStream;
}
interface InsertableEndpoint {
  createEncodedStreams(): EncodedStreams;
}

/** Encoded-frame access through insertable streams (Chromium), held until a pipeline exists. */
function insertableStreams(): boolean {
  return (
    typeof RTCRtpSender !== 'undefined' &&
    'createEncodedStreams' in RTCRtpSender.prototype &&
    typeof RTCRtpReceiver !== 'undefined' &&
    'createEncodedStreams' in RTCRtpReceiver.prototype
  );
}

/**
 * Whether this browser can end-to-end encrypt group-call media: WebRTC encoded-frame access,
 * through insertable streams (Chromium) or RTCRtpScriptTransform (others). There is no fallback:
 * without it, group calls are refused rather than run without end-to-end encryption
 * (docs/calling.md §3, ADR-017).
 */
export function groupCallsSupported(): boolean {
  return insertableStreams() || typeof RTCRtpScriptTransform === 'function';
}

interface WithTransform {
  transform: object | null;
}

/**
 * The media worker of one group call: every sender's frames go through it before leaving the
 * device, every receiver's frames before reaching a decoder.
 *
 * Where insertable streams exist the SFU connection is created with
 * `encodedInsertableStreams` (group-call.ts), so the browser holds frames until the pipeline is
 * attached — no frame can bypass encryption, however late a receiver is announced.
 */
export class MediaE2ee {
  readonly #worker: Worker;
  readonly #insertable = insertableStreams();
  readonly #attached = new WeakSet<object>();
  #onStats: ((stats: MediaWorkerStats) => void) | null = null;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor() {
    if (!groupCallsSupported())
      throw new Error('This browser cannot encrypt call media end to end.');
    this.#worker = startWorker(workerUrl, 'tessera-call-media');
    this.#worker.onmessage = (event: MessageEvent<MediaWorkerStats>) => this.#onStats?.(event.data);
    this.#timer = setInterval(() => this.#post({ type: 'stats' }), 1000);
  }

  /** The SFU connection must be created with insertable streams (see above). */
  get usesInsertableStreams(): boolean {
    return this.#insertable;
  }

  #post(message: MediaWorkerMessage, transfer: Transferable[] = []): void {
    this.#worker.postMessage(message, transfer);
  }

  setEpoch(epoch: number, secret: Uint8Array, ownIndex: number): void {
    this.#post({ type: 'epoch', epoch, secret, ownIndex });
  }

  onStats(listener: (stats: MediaWorkerStats) => void): void {
    this.#onStats = listener;
  }

  protect(
    endpoint: RTCRtpSender | RTCRtpReceiver,
    side: 'send' | 'receive',
    kind: FrameKind,
  ): void {
    // An endpoint's encoded streams can be taken once only.
    if (this.#attached.has(endpoint)) return;
    this.#attached.add(endpoint);
    if (this.#insertable) {
      const { readable, writable } = (
        endpoint as unknown as InsertableEndpoint
      ).createEncodedStreams();
      this.#post({ type: 'streams', side, kind, readable, writable }, [readable, writable]);
      return;
    }
    if (RTCRtpScriptTransform === undefined) return;
    (endpoint as unknown as WithTransform).transform = new RTCRtpScriptTransform(this.#worker, {
      side,
      kind,
    });
  }

  close(): void {
    clearInterval(this.#timer);
    this.#worker.terminate();
  }
}
