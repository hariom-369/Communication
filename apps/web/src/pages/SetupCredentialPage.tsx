import { Alert, Button, TextField } from '@tessera/ui';
import { useState, type SubmitEvent, type ReactNode } from 'react';

import { errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { PageHeading } from '../components/PageHeading.js';
import {
  createPasskey,
  defaultPasskeyName,
  isPasskeyCancellation,
  passkeysSupported,
} from '../lib/webauthn.js';
import { useSession } from '../state/session.js';

/** Final sign-up step: add the first way to sign in. Passkeys are recommended (phishing-resistant). */
export function SetupCredentialPage(): ReactNode {
  const { refresh } = useSession();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'passkey' | 'password'>();
  const supportsPasskeys = passkeysSupported();

  /** The account is now active; the route guard moves on to Security with a welcome message. */
  async function finish() {
    await refresh();
  }

  async function addPasskey() {
    setBusy('passkey');
    setError(undefined);
    try {
      const { flowId, options } = await endpoints.passkeyRegisterOptions();
      await endpoints.passkeyRegisterVerify(
        flowId,
        defaultPasskeyName(),
        await createPasskey(options),
      );
      await finish();
    } catch (caught) {
      if (!isPasskeyCancellation(caught)) setError(errorMessage(caught));
      setBusy(undefined);
    }
  }

  async function setInitialPassword(event: SubmitEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy('password');
    setError(undefined);
    try {
      await endpoints.setInitialPassword(password);
      await finish();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(undefined);
    }
  }

  return (
    <AuthLayout>
      <PageHeading description="Choose how you will sign in. You can add more methods later.">
        Secure your account
      </PageHeading>
      <div className="stack">
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        {supportsPasskeys ? (
          <section className="choice" aria-labelledby="passkey-heading">
            <h2 id="passkey-heading">Use a passkey (recommended)</h2>
            <p>
              Sign in with your fingerprint, face or device PIN. Passkeys cannot be phished or
              leaked.
            </p>
            <Button
              loading={busy === 'passkey'}
              loadingLabel="Waiting for your device"
              disabled={busy === 'password'}
              onClick={() => void addPasskey()}
            >
              Create a passkey
            </Button>
          </section>
        ) : null}
        <section className="choice" aria-labelledby="password-heading">
          <h2 id="password-heading">
            {supportsPasskeys ? 'Or use a password' : 'Choose a password'}
          </h2>
          <form className="stack" onSubmit={(event) => void setInitialPassword(event)}>
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint="At least 12 characters. A few unrelated words work well."
            />
            <TextField
              label="Repeat password"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              loading={busy === 'password'}
              loadingLabel="Saving"
              disabled={busy === 'passkey'}
            >
              Set password
            </Button>
          </form>
        </section>
      </div>
    </AuthLayout>
  );
}
