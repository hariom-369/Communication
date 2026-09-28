import { Alert, Button, TextField } from '@tessera/ui';
import { useState, type SubmitEvent, type ReactNode } from 'react';
import { Link } from 'react-router';

import { errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { PageHeading } from '../components/PageHeading.js';

export function ForgotPasswordPage(): ReactNode {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await endpoints.requestPasswordReset(email.trim());
      setSent(true);
    } catch (caught) {
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
      <PageHeading>Reset your password</PageHeading>
      {sent ? (
        <Alert tone="success" title="Check your email">
          If an account uses {email}, we sent a link to reset its password. The link expires in 30
          minutes.
        </Alert>
      ) : (
        <form className="stack" onSubmit={(event) => void submit(event)}>
          {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" loading={busy} loadingLabel="Sending">
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
