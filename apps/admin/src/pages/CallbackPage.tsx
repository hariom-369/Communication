import { Alert, Skeleton } from '@tessera/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { errorMessage } from '../api.js';
import { endpoints } from '../endpoints.js';
import { useSession } from '../session.js';

/** Where the identity provider sends the browser back (`<admin origin>/auth/callback`). */
export function CallbackPage(): ReactNode {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const started = useRef(false);

  useEffect(() => {
    // Exactly once: the flow is single use (StrictMode runs effects twice in development).
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    // The code must not linger in the address bar or history.
    window.history.replaceState(null, '', '/auth/callback');
    const finish = async () => {
      if (code === null || state === null)
        throw new Error(params.get('error_description') ?? 'Sign-in was cancelled.');
      await endpoints.oidcCallback(code, state);
      await refresh();
      await navigate('/key', { replace: true });
    };
    finish().catch((caught: unknown) => {
      setError(
        caught instanceof Error && !('problem' in caught) ? caught.message : errorMessage(caught),
      );
    });
  }, [navigate, refresh]);

  return (
    <main className="auth">
      <h1>Signing in</h1>
      {error === undefined ? (
        <div role="status" aria-busy="true" aria-label="Checking your sign-in">
          <Skeleton width="16rem" height="1rem" />
        </div>
      ) : (
        <Alert tone="danger" title="Sign-in failed">
          <p>{error}</p>
          <Link to="/sign-in">Start again</Link>
        </Alert>
      )}
    </main>
  );
}
