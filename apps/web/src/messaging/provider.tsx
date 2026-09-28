import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { endpoints } from '../api/endpoints.js';
import { useSession } from '../state/session.js';

import { activeCodec } from './codec.js';
import { MessagingStore, type MessagingSnapshot } from './store.js';

const StoreContext = createContext<MessagingStore | null>(null);

/**
 * Runs the messaging store for the signed-in user while mounted. Renders children without a
 * store when this build has no message codec (messaging unavailable in this build).
 */
export function MessagingProvider({ children }: { children: ReactNode }): ReactNode {
  const { me } = useSession();
  const userId = me?.id;
  const store = useMemo(
    () =>
      activeCodec === null || userId === undefined
        ? null
        : new MessagingStore({
            api: endpoints,
            codec: activeCodec,
            me: { id: userId },
          }),
    [userId],
  );

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
  conversations: [],
  loaded: false,
  error: null,
};
const noop = () => () => undefined;

export function useMessaging(): MessagingSnapshot {
  const store = useMessagingStore();
  return useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? (() => EMPTY));
}
