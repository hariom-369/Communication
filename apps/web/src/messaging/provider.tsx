import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { endpoints } from '../api/endpoints.js';
import { startCryptoWorker } from '../crypto/client.js';
import { useSession } from '../state/session.js';

import { E2eeSession } from './e2ee.js';
import { MessagingStore, type MessagingSnapshot } from './store.js';

const StoreContext = createContext<MessagingStore | null>(null);

/**
 * Runs end-to-end encryption (a dedicated crypto worker) and the messaging store for the
 * signed-in user while mounted.
 */
export function MessagingProvider({ children }: { children: ReactNode }): ReactNode {
  const { me } = useSession();
  const userId = me?.id;
  const store = useMemo(() => {
    if (userId === undefined) return null;
    return new MessagingStore({
      api: endpoints,
      security: new E2eeSession(startCryptoWorker, endpoints, userId),
      me: { id: userId },
    });
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

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
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
