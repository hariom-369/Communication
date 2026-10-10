import { startWorker } from '../lib/worker-policy.js';

import type { CryptoApi, Method, RpcRequest, RpcResponse } from './protocol.js';
import workerUrl from './worker.ts?worker&url';

/** Error raised by the crypto worker, with a stable code (see packages/crypto-core error.rs). */
export class WorkerCryptoError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkerCryptoError';
    this.code = code;
  }
}

export type AsyncCryptoApi = {
  [M in Method]: (...params: Parameters<CryptoApi[M]>) => Promise<ReturnType<CryptoApi[M]>>;
};

/** Minimal port shape, so tests can supply an in-process transport. */
export interface Port {
  postMessage(message: RpcRequest): void;
  onmessage: ((event: MessageEvent<RpcResponse | WorkerEvent>) => void) | null;
  terminate?(): void;
}

/** Unsolicited messages from the worker. */
export interface WorkerEvent {
  readonly event: 'lock-lost';
}

export interface CryptoConnectionControls {
  close(): void;
  /** Another tab took over this device's encryption (the worker can no longer be used). */
  onLockLost(listener: () => void): void;
}

/** Main-thread proxy for the crypto worker: one promise per request, matched by id. */
export function createCryptoClient(port: Port): AsyncCryptoApi & CryptoConnectionControls {
  let nextId = 1;
  let lockLost: (() => void) | null = null;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  port.onmessage = (event) => {
    if ('event' in event.data) {
      // The only event: another tab took this device's encryption lock.
      lockLost?.();
      return;
    }
    const response = event.data;
    const entry = pending.get(response.id);
    if (entry === undefined) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new WorkerCryptoError(response.code, response.message));
  };
  const call = (method: Method, params: unknown[]) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.postMessage({ id, method, params });
    });
  return new Proxy({} as AsyncCryptoApi & CryptoConnectionControls, {
    get: (_target, property) => {
      if (property === 'onLockLost') {
        return (listener: () => void) => {
          lockLost = listener;
        };
      }
      if (property === 'close') {
        return () => {
          port.terminate?.();
          for (const entry of pending.values())
            entry.reject(new WorkerCryptoError('CLOSED', 'Encryption engine stopped.'));
          pending.clear();
        };
      }
      if (property === 'then') return undefined; // not a thenable
      return (...params: unknown[]) => call(property as Method, params);
    },
  });
}

/** Starts the dedicated crypto worker. */
export function startCryptoWorker(): AsyncCryptoApi & CryptoConnectionControls {
  return createCryptoClient(startWorker(workerUrl, 'tessera-crypto'));
}
