import type { AdminMe } from '@tessera/validation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ApiError, NetworkError, onSignedOut } from './api.js';
import { endpoints } from './endpoints.js';

/**
 * `key`: the identity provider step is done but the security key step is not (the API refuses
 * everything else for such a session). `active`: signed in, with the roles in `me`.
 */
export type SessionStatus = 'loading' | 'signed_out' | 'key' | 'active' | 'offline';

interface SessionValue {
  readonly status: SessionStatus;
  readonly me: AdminMe | null;
  readonly refresh: () => Promise<void>;
  /** Whether the current roles allow a capability (the API decides; this only shapes the UI). */
  readonly can: (capability: string) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

async function load(): Promise<{ status: SessionStatus; me: AdminMe | null }> {
  try {
    return { status: 'active', me: await endpoints.me() };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'UNAUTHENTICATED')
      return { status: 'signed_out', me: null };
    if (error instanceof ApiError && error.code === 'FORBIDDEN') return { status: 'key', me: null };
    if (error instanceof NetworkError) return { status: 'offline', me: null };
    throw error;
  }
}

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<{ status: SessionStatus; me: AdminMe | null }>({
    status: 'loading',
    me: null,
  });

  const refresh = useCallback(async () => {
    setState(await load());
  }, []);

  useEffect(() => {
    let live = true;
    void load().then((next) => {
      if (live) setState(next);
    });
    const stop = onSignedOut(() => {
      setState({ status: 'signed_out', me: null });
    });
    return () => {
      live = false;
      stop();
    };
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      ...state,
      refresh,
      can: (capability) => state.me?.capabilities.includes(capability) === true,
    }),
    [state, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
