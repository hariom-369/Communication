import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { endpoints } from '../api/endpoints.js';
import { CallManager, IDLE_CALL, type CallSnapshot } from '../calls/manager.js';
import { startCryptoWorker } from '../crypto/client.js';
import { startNotificationBridge } from '../notifications/bridge.js';
import { clearUnseen, readUnseen } from '../notifications/device-prefs.js';
import { useSession } from '../state/session.js';

import { E2eeSession } from './e2ee.js';
import { MediaTransfer } from './media-transfer.js';
import { MessagingStore, type MessagingSnapshot } from './store.js';

const StoreContext = createContext<MessagingStore | null>(null);
const E2eeContext = createContext<E2eeSession | null>(null);
const MediaContext = createContext<MediaTransfer | null>(null);
const CallsContext = createContext<CallManager | null>(null);

/**
 * Runs end-to-end encryption (a dedicated crypto worker) and the messaging store for the
 * signed-in user while mounted.
 */
export function MessagingProvider({ children }: { children: ReactNode }): ReactNode {
  const { me } = useSession();
  const userId = me?.id;
  const { store, e2ee, media, calls } = useMemo(() => {
    if (userId === undefined) return { store: null, e2ee: null, media: null, calls: null };
    const session = new E2eeSession(startCryptoWorker, endpoints, userId);
    const transfer = new MediaTransfer(endpoints, session);
    const messaging = new MessagingStore({
      api: endpoints,
      security: session,
      me: { id: userId },
      media: transfer,
      unseen: {
        load: () => readUnseen(userId),
        clear: (conversationId) => {
          clearUnseen(userId, conversationId).catch(() => undefined);
        },
      },
    });
    return {
      e2ee: session,
      media: transfer,
      store: messaging,
      calls: new CallManager({ api: endpoints, store: messaging, security: session, me: userId }),
    };
  }, [userId]);

  useEffect(() => {
    if (store === null) return;
    const refreshPrivacy = () => {
      endpoints.privacy().then(
        (settings) => {
          store.setShareReadReceipts(settings.readReceipts);
        },
        () => undefined,
      );
    };
    const online = () => {
      store.online();
    };
    const offline = () => {
      store.offline();
    };
    refreshPrivacy();
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    window.addEventListener('focus', refreshPrivacy);
    void store.start();
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      window.removeEventListener('focus', refreshPrivacy);
      store.stop();
    };
  }, [store]);

  useEffect(() => () => calls?.dispose(), [calls]);

  useEffect(() => {
    if (store === null || userId === undefined) return;
    return startNotificationBridge({ store, e2ee, userId });
  }, [store, e2ee, userId]);

  return (
    <E2eeContext.Provider value={e2ee}>
      <MediaContext.Provider value={media}>
        <StoreContext.Provider value={store}>
          <CallsContext.Provider value={calls}>{children}</CallsContext.Provider>
        </StoreContext.Provider>
      </MediaContext.Provider>
    </E2eeContext.Provider>
  );
}

/** Calls on this device (docs/calling.md) and their current state. */
export function useCalls(): { manager: CallManager | null; call: CallSnapshot } {
  const manager = useContext(CallsContext);
  const call = useSyncExternalStore(
    manager?.subscribe ?? noop,
    manager?.getSnapshot ?? (() => IDLE_CALL),
  );
  return { manager, call };
}

/** Encrypted attachment transfer (download and decrypt for display). */
export function useMediaTransfer(): MediaTransfer | null {
  return useContext(MediaContext);
}

/** This device's end-to-end encryption session (devices, linking, backups); re-renders on change. */
export function useE2ee(): E2eeSession | null {
  const session = useContext(E2eeContext);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => session?.subscribe(rerender), [session]);
  return session;
}

export function useMessagingStore(): MessagingStore | null {
  return useContext(StoreContext);
}

const EMPTY: MessagingSnapshot = {
  status: 'connecting',
  device: 'starting',
  conversations: [],
  loaded: false,
  error: null,
  uploads: {},
  spaces: {},
  communityVersion: 0,
};
const noop = () => () => undefined;

export function useMessaging(): MessagingSnapshot {
  const store = useMessagingStore();
  return useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? (() => EMPTY));
}
