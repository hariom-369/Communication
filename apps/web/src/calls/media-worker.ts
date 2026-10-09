/// <reference lib="webworker" />
import { CallFrameCrypto, clearPrefixLength, type FrameKind } from './frame-crypto.js';

/**
 * Group-call media worker (ADR-047): every outgoing frame is SFrame-encrypted before it leaves
 * this device and every incoming frame is decrypted before it reaches a decoder. Frames that do
 * not authenticate (no key yet, removed sender, tampering, anything unencrypted) are dropped.
 * One worker serves all tracks of a call, so the sender counter is shared and never repeats.
 */

interface EncodedFrame {
  data: ArrayBuffer;
  readonly type?: 'key' | 'delta' | 'empty';
}
interface ScriptTransformer {
  readonly readable: ReadableStream<EncodedFrame>;
  readonly writable: WritableStream<EncodedFrame>;
  readonly options: { side: 'send' | 'receive'; kind: FrameKind };
}

export type MediaWorkerMessage =
  | { type: 'epoch'; epoch: number; secret: Uint8Array; ownIndex: number }
  | { type: 'stats' }
  /** Insertable streams of one sender or receiver (Chromium). */
  | {
      type: 'streams';
      side: 'send' | 'receive';
      kind: FrameKind;
      readable: ReadableStream;
      writable: WritableStream;
    };

export interface MediaWorkerStats {
  type: 'stats';
  epoch: number | null;
  sent: number;
  received: number;
  /** Incoming frames dropped because they did not decrypt. */
  dropped: number;
  /** Sender indexes whose frames decrypted recently. */
  senders: number[];
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
/** `onrtctransform` (WebRTC Encoded Transform), typed locally: not in every TypeScript lib. */
const transforms = self as unknown as {
  onrtctransform: ((event: { transformer: ScriptTransformer }) => void) | null;
};
const frames = new CallFrameCrypto();
const counts = { sent: 0, received: 0, dropped: 0 };
let senders = new Set<number>();

scope.onmessage = (event: MessageEvent<MediaWorkerMessage>) => {
  const message = event.data;
  if (message.type === 'epoch')
    frames.setEpoch({ epoch: message.epoch, secret: message.secret, ownIndex: message.ownIndex });
  else if (message.type === 'streams')
    pump(
      message.readable as ReadableStream<EncodedFrame>,
      message.writable as WritableStream<EncodedFrame>,
      message.side,
      message.kind,
    );
  else {
    const stats: MediaWorkerStats = {
      type: 'stats',
      epoch: frames.currentEpoch,
      ...counts,
      senders: [...senders],
    };
    senders = new Set();
    scope.postMessage(stats);
  }
};

async function protect(frame: EncodedFrame, side: 'send' | 'receive', kind: FrameKind) {
  const data = new Uint8Array(frame.data);
  const prefix = clearPrefixLength(kind, frame.type === 'key');
  if (side === 'send') {
    const sealed = await frames.encrypt(data, prefix);
    if (sealed === null) return null; // no key yet: send nothing rather than plaintext
    frame.data = sealed.buffer as ArrayBuffer;
    counts.sent += 1;
    return frame;
  }
  const opened = await frames.decrypt(data, prefix);
  if (opened === null) {
    counts.dropped += 1;
    return null;
  }
  frame.data = opened.data.buffer as ArrayBuffer;
  counts.received += 1;
  senders.add(opened.senderIndex);
  return frame;
}

/** Moves every frame of one sender or receiver through encryption or decryption. */
function pump(
  readable: ReadableStream<EncodedFrame>,
  writable: WritableStream<EncodedFrame>,
  side: 'send' | 'receive',
  kind: FrameKind,
): void {
  const reader: ReadableStreamDefaultReader<EncodedFrame> = readable.getReader();
  const writer: WritableStreamDefaultWriter<EncodedFrame> = writable.getWriter();
  void (async () => {
    for (;;) {
      const result: ReadableStreamReadResult<EncodedFrame> = await reader.read();
      if (result.done) return;
      const value: EncodedFrame = result.value;
      const out = await protect(value, side, kind);
      if (out !== null) await writer.write(out);
    }
  })();
}

transforms.onrtctransform = ({ transformer }: { transformer: ScriptTransformer }) => {
  pump(
    transformer.readable,
    transformer.writable,
    transformer.options.side,
    transformer.options.kind,
  );
};
