import { Alert, Button } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';

import { errorMessage } from '../api.js';
import { endpoints } from '../endpoints.js';
import { useSession } from '../session.js';

/** Staff sign in with the company identity provider, then their security key. */
export function SignInPage(): ReactNode {
  const { status } = useSession();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (status === 'active') return <Navigate to="/" replace />;
  if (status === 'key') return <Navigate to="/key" replace />;

  async function start() {
    setBusy(true);
    setError(undefined);
    try {
      const { authorizationUrl } = await endpoints.oidcStart();
      window.location.assign(authorizationUrl);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <h1>Tessera admin</h1>
      <p>For Tessera staff. Sign in with your company account, then your security key.</p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <Button onClick={() => void start()} loading={busy} loadingLabel="Opening sign-in">
        Sign in with your company account
      </Button>
      <p className="muted">
        Every action in this console is recorded. You can only see a person&apos;s account for a
        ticket, a case or a recorded investigation.
      </p>
    </main>
  );
}
