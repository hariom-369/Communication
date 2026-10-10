import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import { useState, type ReactNode, type SubmitEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { errorMessage } from '../api.js';
import { endpoints } from '../endpoints.js';
import { useSession } from '../session.js';
import { useResource } from '../use-resource.js';
import { answerKeyPrompt, isKeyCancellation, isRegistration } from '../webauthn.js';

/**
 * The second step: register your security key (first sign-in) or use it. Only hardware-bound
 * keys are accepted — synced passkeys are refused by the API.
 */
export function KeyStepPage(): ReactNode {
  const { status, refresh } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState('Security key');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const options = useResource(loadOptions);

  if (status === 'signed_out') return <Navigate to="/sign-in" replace />;
  if (status === 'active') return <Navigate to="/" replace />;
  const registering = options.data !== undefined && isRegistration(options.data.options);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (options.data === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await answerKeyPrompt(options.data.options);
      await endpoints.keyVerify(options.data.flowId, response, registering ? name : undefined);
      await refresh();
      await navigate('/', { replace: true });
    } catch (caught) {
      setError(
        isKeyCancellation(caught)
          ? 'The security key prompt was dismissed. Try again when your key is ready.'
          : errorMessage(caught),
      );
      setBusy(false);
      // A fresh challenge for the next attempt (each one is single use).
      options.reload();
    }
  }

  return (
    <main className="auth">
      <h1>{registering ? 'Register your security key' : 'Use your security key'}</h1>
      {options.error === undefined ? null : <Alert tone="danger">{options.error}</Alert>}
      {options.data === undefined && options.error === undefined ? (
        <Skeleton width="16rem" height="1rem" />
      ) : null}
      {options.data === undefined ? null : (
        <form className="stack" onSubmit={(event) => void submit(event)}>
          {registering ? (
            <>
              <p>
                This is your first sign-in. Register a hardware security key — synced passkeys (in a
                password manager or phone account) are not accepted for the admin console.
              </p>
              <TextField
                label="Name this key"
                required
                maxLength={64}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </>
          ) : (
            <p>Insert or touch your security key to finish signing in.</p>
          )}
          {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
          <Button type="submit" loading={busy} loadingLabel="Waiting for your key">
            {registering ? 'Register key' : 'Use security key'}
          </Button>
        </form>
      )}
    </main>
  );
}

const loadOptions = (): ReturnType<typeof endpoints.keyOptions> => endpoints.keyOptions();
