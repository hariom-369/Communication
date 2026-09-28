import { Alert, Button, TextField } from '@tessera/ui';
import { useState, type SubmitEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { ApiError, errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { PageHeading } from '../components/PageHeading.js';
import { getPasskeyAssertion, isPasskeyCancellation, passkeysSupported } from '../lib/webauthn.js';
import { useSession } from '../state/session.js';

export function LoginPage(): ReactNode {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'password' | 'passkey'>();

  async function signedIn() {
    await refresh();
    await navigate('/settings/security', { replace: true });
  }

  async function withPassword(event: SubmitEvent) {
    event.preventDefault();
    setBusy('password');
    setError(undefined);
    try {
      const { stage } = await endpoints.login(identifier.trim(), password);
      if (stage === 'mfa_pending') await navigate('/login/verify', { replace: true });
      else await signedIn();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'INVALID_CREDENTIALS'
          ? 'The email/username or password is incorrect.'
          : errorMessage(caught),
      );
      setBusy(undefined);
    }
  }

  async function withPasskey() {
    setBusy('passkey');
    setError(undefined);
    try {
      const { flowId, options } = await endpoints.passkeyLoginOptions('login');
      await endpoints.passkeyLoginVerify(flowId, await getPasskeyAssertion(options));
      await signedIn();
    } catch (caught) {
      if (!isPasskeyCancellation(caught)) {
        setError(
          caught instanceof ApiError && caught.code === 'INVALID_CREDENTIALS'
            ? 'That passkey is not registered with Tessera.'
            : errorMessage(caught),
        );
      }
      setBusy(undefined);
    }
  }

  return (
    <AuthLayout
      footer={
        <p>
          New to Tessera? <Link to="/signup">Create an account</Link>
        </p>
      }
    >
      <PageHeading>Sign in</PageHeading>
      <div className="stack">
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        {passkeysSupported() ? (
          <Button
            loading={busy === 'passkey'}
            loadingLabel="Waiting for your device"
            disabled={busy === 'password'}
            onClick={() => void withPasskey()}
          >
            Sign in with a passkey
          </Button>
        ) : null}
        <form className="stack" onSubmit={(event) => void withPassword(event)}>
          <TextField
            label="Email or username"
            autoComplete="username"
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            loading={busy === 'password'}
            loadingLabel="Signing in"
            disabled={busy === 'passkey'}
          >
            Sign in with password
          </Button>
        </form>
        <p>
          <Link to="/forgot-password">Forgot your password?</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
