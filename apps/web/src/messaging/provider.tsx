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
import { startCryptoWorker } from '../crypto/client.js';
import { useSession } from '../state/session.js';

import { E2eeSession } from './e2ee.js';
import { MessagingStore, type MessagingSnapshot } from './store.js';

const StoreContext = createContext<MessagingStore | null>(null);
const E2eeContext = createContext<E2eeSession | null>(null);

/**
 * Runs end-to-end encryption (a dedicated crypto worker) and the messaging store for the
 * signed-in user while mounted.
 */
export function MessagingProvider({ children }: { children: ReactNode }): ReactNode {
  const { me } = useSession();
  const userId = me?.id;
  const { store, e2ee } = useMemo(() => {
    if (userId === undefined) return { store: null, e2ee: null };
    const session = new E2eeSession(startCryptoWorker, endpoints, userId);
    return {
      e2ee: session,
      store: new MessagingStore({ api: endpoints, security: session, me: { id: userId } }),
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

  return (
    <E2eeContext.Provider value={e2ee}>
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    </E2eeContext.Provider>
  );
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
};
const noop = () => () => undefined;

export function useMessaging(): MessagingSnapshot {
  const store = useMessagingStore();
  return useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? (() => EMPTY));
}
