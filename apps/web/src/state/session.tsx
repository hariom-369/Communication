import type { MeResponse } from '@tessera/validation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ApiError, onAccountSuspended } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { moderationEndpoints } from '../api/moderation-endpoints.js';

/** `suspended`: signed in, but the account is suspended or banned (only its status page). */
export type SessionStatus = 'loading' | 'anonymous' | 'setup' | 'active' | 'suspended' | 'offline';

/** Active accounts are checked for a suspension or ban (docs/moderation.md §5). */
async function load(): Promise<{ account: MeResponse; status: SessionStatus }> {
  const account = await endpoints.me();
  if (account.status !== 'active') return { account, status: 'setup' };
  const standing = await moderationEndpoints.standing();
  const suspended = standing.status === 'suspended' || standing.status === 'banned';
  return { account, status: suspended ? 'suspended' : 'active' };
}

interface SessionValue {
  readonly status: SessionStatus;
  readonly me: MeResponse | null;
  /** Re-reads the account from the server (after sign-in, credential changes, …). */
  readonly refresh: () => Promise<SessionStatus>;
  /** Local sign-out bookkeeping after the server session is gone. */
  readonly clear: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * The browser cannot read the HttpOnly session cookie, so the session state is whatever
 * `GET /accounts/me` says: 401 → anonymous, pending_credential → setup, otherwise active.
 */
export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);

  const refresh = useCallback(async (): Promise<SessionStatus> => {
    try {
      const { account, status: next } = await load();
      setMe(account);
      setStatus(next);
      return next;
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === 'UNAUTHENTICATED' || error.code === 'FORBIDDEN')
      ) {
        setMe(null);
        setStatus('anonymous');
        return 'anonymous';
      }
      setStatus('offline');
      return 'offline';
    }
  }, []);

  const clear = useCallback(() => {
    setMe(null);
    setStatus('anonymous');
  }, []);

  // Initial load: same logic as `refresh`, written as a cancellable effect.
  useEffect(() => {
    let cancelled = false;
    load().then(
      ({ account, status: next }) => {
        if (cancelled) return;
        setMe(account);
        setStatus(next);
      },
      (error: unknown) => {
        if (cancelled) return;
        const signedOut =
          error instanceof ApiError &&
          (error.code === 'UNAUTHENTICATED' || error.code === 'FORBIDDEN');
        setStatus(signedOut ? 'anonymous' : 'offline');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Any request refused because the account was suspended in the meantime: show the status page.
  useEffect(() => onAccountSuspended(() => setStatus('suspended')), []);

  const value = useMemo(() => ({ status, me, refresh, clear }), [status, me, refresh, clear]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
