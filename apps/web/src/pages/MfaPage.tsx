import { Alert, Button, TextField } from '@tessera/ui';
import { useState, type SubmitEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { PageHeading } from '../components/PageHeading.js';
import { useSession } from '../state/session.js';

export function MfaPage(): ReactNode {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await endpoints.loginMfa(
        mode === 'totp' ? { totpCode: code.trim() } : { recoveryCode: code.trim() },
      );
      await refresh();
      await navigate('/settings/security', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      footer={
        <p>
          <Link to="/login">Start over</Link>
        </p>
      }
    >
      <PageHeading
        description={
          mode === 'totp'
            ? 'Enter the 6-digit code from your authenticator app.'
            : 'Enter one of the recovery codes you saved. Each code works once.'
        }
      >
        Two-step verification
      </PageHeading>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        <TextField
          key={mode}
          label={mode === 'totp' ? 'Authentication code' : 'Recovery code'}
          autoComplete="one-time-code"
          inputMode={mode === 'totp' ? 'numeric' : 'text'}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button type="submit" loading={busy} loadingLabel="Verifying">
          Verify
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setMode(mode === 'totp' ? 'recovery' : 'totp');
            setCode('');
            setError(undefined);
          }}
        >
          {mode === 'totp' ? 'Use a recovery code instead' : 'Use an authenticator code instead'}
        </Button>
      </form>
    </AuthLayout>
  );
}
