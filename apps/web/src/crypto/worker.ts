/// <reference lib="webworker" />
import init, {
  CryptoClient,
  MediaDecryptor,
  MediaEncryptor,
  parseLinkCode,
  verifyLinkCode,
} from '@tessera/crypto-core';
import wasmUrl from '@tessera/crypto-core/wasm?url';

import { CryptoEngine, CryptoError } from './engine.js';
import type { RpcRequest, RpcResponse } from './protocol.js';

/**
 * Dedicated crypto worker (ADR-006): the only place where private keys and MLS state exist in
 * memory. Loads the WebAssembly core and serves typed RPC calls from the main thread.
 */

declare const self: DedicatedWorkerGlobalScope;

const ready = init({ module_or_path: wasmUrl });
const engine = new CryptoEngine({
  CryptoClient,
  MediaEncryptor,
  MediaDecryptor,
  parseLinkCode,
  verifyLinkCode,
});

self.onmessage = (event: MessageEvent<RpcRequest>) => {
  const { id, method, params } = event.data;
  void (async () => {
    let response: RpcResponse;
    try {
      await ready;
      const result = await engine.call(method, params as never);
      response = { id, ok: true, result };
    } catch (error) {
      response =
        error instanceof CryptoError
          ? { id, ok: false, code: error.code, message: error.message }
          : { id, ok: false, code: 'INTERNAL', message: 'Encryption engine error.' };
    }
    self.postMessage(response);
  })();
};
