import { Alert, Button, TextField } from '@tessera/ui';
import { useState, type SubmitEvent, type ReactNode } from 'react';
import { Link } from 'react-router';

import { ApiError, errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { PageHeading } from '../components/PageHeading.js';

/** Reads the token from the URL fragment once, then removes it from the address bar and history. */
function takeTokenFromFragment(): string | null {
  const match = /(?:^|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash.slice(1));
  if (match?.[1] !== undefined) {
    window.history.replaceState(null, '', window.location.pathname);
    return match[1];
  }
  return null;
}

export function ResetPasswordPage(): ReactNode {
  const [token] = useState(takeTokenFromFragment);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (token === null) return;
    setBusy(true);
    setError(undefined);
    const trimmed = code.trim();
    try {
      await endpoints.completePasswordReset({
        token,
        password,
        ...(trimmed === ''
          ? {}
          : /^\d{6}$/.test(trimmed)
            ? { totpCode: trimmed }
            : { recoveryCode: trimmed }),
      });
      setDone(true);
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.code === 'INVALID_CODE' &&
        caught.problem.detail !== undefined
      )
        setNeedsCode(true);
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <AuthLayout
      footer={
        <p>
          <Link to="/login">Back to sign in</Link>
        </p>
      }
    >
      <PageHeading>Choose a new password</PageHeading>
      {token === null ? (
        <Alert tone="warning" title="This link is not valid">
          Open the link from your most recent reset email, or{' '}
          <Link to="/forgot-password">request a new one</Link>.
        </Alert>
      ) : done ? (
        <Alert tone="success" title="Password changed">
          All sessions were signed out. <Link to="/login">Sign in with your new password</Link>.
        </Alert>
      ) : (
        <form className="stack" onSubmit={(event) => void submit(event)}>
          {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="At least 12 characters."
          />
          {needsCode ? (
            <TextField
              label="Authenticator or recovery code"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              hint="Two-step verification is on for this account."
            />
          ) : null}
          <Button type="submit" loading={busy} loadingLabel="Saving">
            Change password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
