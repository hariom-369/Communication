import { Alert, Button, TextField } from '@tessera/ui';
import { useState, type SubmitEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';

import { errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { PageHeading } from '../components/PageHeading.js';
import { useSession } from '../state/session.js';

export function VerifyEmailPage(): ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh } = useSession();
  // The address travels in router state, not the URL, so it stays out of history and logs.
  const email = (location.state as { email?: string } | null)?.email;
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (email === undefined) return <Navigate to="/signup" replace />;

  async function verify(event: SubmitEvent) {
    event.preventDefault();
    if (email === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await endpoints.verifyEmail(email, code.trim());
      await refresh();
      await navigate('/setup', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  async function resend() {
    if (email === undefined) return;
    setError(undefined);
    try {
      await endpoints.resendVerification(email);
      setNotice('If this address is waiting for verification, a new code is on its way.');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <AuthLayout
      footer={
        <p>
          <Link to="/signup">Use a different email</Link>
        </p>
      }
    >
      <PageHeading description={`We sent a 6-digit code to ${email}. It expires in 15 minutes.`}>
        Check your email
      </PageHeading>
      <form className="stack" onSubmit={(event) => void verify(event)}>
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        {notice === undefined ? null : <Alert tone="info">{notice}</Alert>}
        <TextField
          label="Verification code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button type="submit" loading={busy} loadingLabel="Verifying">
          Verify email
        </Button>
        <Button variant="ghost" onClick={() => void resend()}>
          Send a new code
        </Button>
      </form>
    </AuthLayout>
  );
}
