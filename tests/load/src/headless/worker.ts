import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

import { Agent, fetch as undiciFetch } from 'undici';

import init, {
  CryptoClient,
  MediaDecryptor,
  MediaEncryptor,
  parseLinkCode,
  verifyLinkCode,
} from '@tessera/crypto-core';
import WebSocket from 'ws';

import { endpoints } from '../../../../apps/web/src/api/endpoints.js';
import { createCryptoClient, type Port } from '../../../../apps/web/src/crypto/client.js';
import { CryptoEngine, CryptoError } from '../../../../apps/web/src/crypto/engine.js';
import type { RpcRequest, RpcResponse } from '../../../../apps/web/src/crypto/protocol.js';
import { E2eeSession } from '../../../../apps/web/src/messaging/e2ee.js';
import { RealtimeClient } from '../../../../apps/web/src/messaging/realtime-client.js';
import { MessagingStore } from '../../../../apps/web/src/messaging/store.js';

/**
 * A headless Tessera client (one per worker thread): the web app's own messaging store, E2EE
 * session and encryption engine (the Rust core in WebAssembly), unchanged, with the browser
 * parts replaced — an in-memory IndexedDB, the crypto engine in-process instead of in a Web
 * Worker, `fetch` pointed at the API with this user's session cookie, and a `ws` socket that
 * sends the Origin header a browser would. Everything on the wire is real MLS.
 *
 * Messages it sends are `load:<sentAtMs>:<n>`; it reports each one it receives (decrypted)
 * with its latency and number, so the coordinator can check order and loss.
 */

export interface HeadlessData {
  readonly userId: string;
  readonly username: string;
  readonly token: string;
  readonly api: string;
  readonly realtime: string;
  readonly origin: string;
  /** Local source address (clients do not share an address, as real users would not). */
  readonly localAddress: string;
}

export type HeadlessCommand =
  | { readonly cmd: 'start' }
  | { readonly cmd: 'open'; readonly peer: string }
  /** Waits until a conversation someone else created (a Welcome) is known here. */
  | { readonly cmd: 'join'; readonly conversationId: string }
  | { readonly cmd: 'send'; readonly conversationId: string; readonly n: number }
  | { readonly cmd: 'stop' };

export type HeadlessEvent =
  | { readonly event: 'ready'; readonly ms: number }
  | { readonly event: 'opened'; readonly conversationId: string; readonly ms: number }
  | { readonly event: 'joined'; readonly conversationId: string; readonly ms: number }
  | {
      readonly event: 'received';
      readonly conversationId: string;
      readonly from: string;
      readonly n: number;
      readonly latencyMs: number;
    }
  | { readonly event: 'error'; readonly message: string }
  /** Information for the log (not a failure). */
  | { readonly event: 'diagnostic'; readonly message: string };

const data = workerData as HeadlessData;
const post = (event: HeadlessEvent) => parentPort?.postMessage(event);

// The API client calls same-origin paths with the session cookie: point them at the API, from
// this client's own source address.
// (undici ignores `connect.localAddress`; a connector binding the socket itself does not.)
const dispatcher = new Agent({
  connect: (options, callback) => {
    const socket = net.connect({
      host: options.hostname,
      port: Number(options.port),
      localAddress: data.localAddress,
    });
    socket.once('connect', () => {
      callback(null, socket);
    });
    socket.once('error', (error) => {
      callback(error, null);
    });
  },
});
globalThis.fetch = (async (input: RequestInfo | URL, request?: RequestInit) => {
  const url = typeof input === 'string' && input.startsWith('/') ? new URL(input, data.api) : input;
  const headers = new Headers(request?.headers);
  headers.set('cookie', `__Host-tsid=${data.token}`);
  headers.set('origin', data.origin);
  const response = await undiciFetch(url as string | URL, {
    method: request?.method ?? 'GET',
    headers: Object.fromEntries(headers),
    body: (request?.body ?? null) as string | null,
    dispatcher,
  });
  const counted = `${request?.method ?? 'GET'} ${new URL(String(url), data.api).pathname.replace(/[0-9a-f-]{36}/g, ':id')} ${String(response.status)}`;
  requestCounts.set(counted, (requestCounts.get(counted) ?? 0) + 1);
  if (response.status === 429) {
    const path = new URL(String(url), data.api).pathname.replace(/[0-9a-f-]{36}/g, ':id');
    const key = `${request?.method ?? 'GET'} ${path}`;
    if (!limited.has(key)) {
      limited.add(key);
      const detail = await response.clone().text();
      parentPort?.postMessage({ event: 'error', message: `429 on ${key}: ${detail.slice(0, 200)}` });
    }
  }
  return response as unknown as Response;
}) as typeof globalThis.fetch;
const limited = new Set<string>();
/** Requests by method, path and status (reported on `stop`, for diagnosing client behaviour). */
const requestCounts = new Map<string, number>();

// A browser logs an unhandled rejection and keeps running; so does this client, but it reports
// each one (a fire-and-forget promise without a handler is a finding).
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  parentPort?.postMessage({ event: 'error', message: `unhandled rejection: ${message}` });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(
  path.resolve(here, '../../../packages/crypto-core/pkg/crypto_core_bg.wasm'),
);
await init({ module_or_path: wasm });

const engine = new CryptoEngine({
  CryptoClient,
  MediaEncryptor,
  MediaDecryptor,
  parseLinkCode,
  verifyLinkCode,
});

/** The worker boundary, in-process: same requests, same responses, structured-cloned. */
function inProcessPort(): Port {
  const port: Port = {
    onmessage: null,
    postMessage(request: RpcRequest) {
      void (async () => {
        let response: RpcResponse;
        try {
          const result = await engine.call(request.method, request.params as never);
          response = { id: request.id, ok: true, result: structuredClone(result) };
        } catch (error) {
          response =
            error instanceof CryptoError
              ? { id: request.id, ok: false, code: error.code, message: error.message }
              : { id: request.id, ok: false, code: 'INTERNAL', message: String(error) };
        }
        port.onmessage?.({ data: response } as MessageEvent<RpcResponse>);
      })();
    },
  };
  return port;
}

const session = new E2eeSession(
  () => createCryptoClient(inProcessPort()),
  endpoints,
  data.userId,
  // No authenticator here: passkey-protected backups are unavailable, as in a browser without
  // the WebAuthn PRF extension.
  () => Promise.reject(new Error('No passkey on a headless client')),
);
const store = new MessagingStore({
  api: endpoints,
  security: session,
  me: { id: data.userId },
  createRealtime: (options) =>
    new RealtimeClient({
      ...options,
      websocketBase: data.realtime,
      createSocket: (url, protocol) =>
        new WebSocket(url, protocol, {
          origin: data.origin,
          localAddress: data.localAddress,
        }) as unknown as globalThis.WebSocket,
    }),
});

store.onIncoming((incoming) => {
  if (incoming.body.kind !== 'text') return;
  const match = /^load:(\d+):(\d+)$/.exec(incoming.body.text);
  if (match === null) return;
  post({
    event: 'received',
    conversationId: incoming.conversationId,
    from: incoming.senderUserId,
    n: Number(match[2]),
    latencyMs: Date.now() - Number(match[1]),
  });
});

async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const known = (conversationId: string) =>
  store.getSnapshot().conversations.some((conversation) => conversation.meta.id === conversationId);

async function handle(command: HeadlessCommand): Promise<void> {
  switch (command.cmd) {
    case 'start': {
      const started = Date.now();
      await store.start();
      await until(() => session.status === 'ready', 60_000, `E2EE ready (${session.status})`);
      post({ event: 'ready', ms: Date.now() - started });
      return;
    }
    case 'open': {
      const started = Date.now();
      const conversationId = await store.openDirect(command.peer);
      post({ event: 'opened', conversationId, ms: Date.now() - started });
      return;
    }
    case 'join': {
      const started = Date.now();
      await until(() => known(command.conversationId), 60_000, 'Welcome');
      post({ event: 'joined', conversationId: command.conversationId, ms: Date.now() - started });
      return;
    }
    case 'send':
      // The store ignores a send into a conversation it does not know (the UI offers none).
      if (!known(command.conversationId)) {
        post({ event: 'error', message: `send ${String(command.n)} dropped: conversation unknown` });
        return;
      }
      store.sendText(
        command.conversationId,
        `load:${String(Date.now())}:${String(command.n)}`,
        null,
      );
      return;
    case 'stop': {
      // Own messages the server never accepted (failed, or still waiting in the outbox).
      const unsent: Record<string, number> = {};
      for (const conversation of store.getSnapshot().conversations)
        for (const message of Object.values(conversation.timeline.byId))
          if (message.senderId === data.userId && message.seq === null)
            unsent[message.status ?? 'sending'] = (unsent[message.status ?? 'sending'] ?? 0) + 1;
      if (Object.keys(unsent).length > 0)
        post({ event: 'error', message: `unsent own messages ${JSON.stringify(unsent)}` });
      if (process.env['LOAD_REQUEST_COUNTS'] === '1')
        post({
          event: 'diagnostic',
          message: `requests ${JSON.stringify([...requestCounts].sort((a, b) => b[1] - a[1]).slice(0, 12))}`,
        });
      store.stop();
      session.stop();
      setTimeout(() => process.exit(0), 100);
      return;
    }
  }
}

parentPort?.on('message', (command: HeadlessCommand) => {
  handle(command).catch((error: unknown) => {
    post({ event: 'error', message: error instanceof Error ? error.message : String(error) });
  });
});
