import { Alert, Button, Dialog, TextField } from '@tessera/ui';
import { useState, type SubmitEvent, type ReactNode } from 'react';

import { ApiError, errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { getPasskeyAssertion, isPasskeyCancellation, passkeysSupported } from '../lib/webauthn.js';
import { useSession } from '../state/session.js';

/**
 * Step-up confirmation (docs/authentication.md §4): password (plus authenticator code when 2FA is
 * on) or a passkey. Shown when the API requires recent authentication for a sensitive action.
 */
export function ReauthDialog({
  open,
  onDone,
}: {
  open: boolean;
  onDone: (confirmed: boolean) => void;
}): ReactNode {
  const { me } = useSession();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const needsCode = me?.security.totpEnabled === true;

  function close(confirmed: boolean) {
    setPassword('');
    setCode('');
    setError(undefined);
    setBusy(false);
    onDone(confirmed);
  }

  async function withPassword(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const trimmed = code.trim();
      await endpoints.reauthPassword({
        password,
        ...(trimmed === ''
          ? {}
          : /^\d{6}$/.test(trimmed)
            ? { totpCode: trimmed }
            : { recoveryCode: trimmed }),
      });
      close(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'INVALID_CREDENTIALS'
          ? 'That password is not correct.'
          : errorMessage(caught),
      );
      setBusy(false);
    }
  }

  async function withPasskey() {
    setBusy(true);
    setError(undefined);
    try {
      const { flowId, options } = await endpoints.passkeyLoginOptions('reauth');
      await endpoints.reauthPasskey(flowId, await getPasskeyAssertion(options));
      close(true);
    } catch (caught) {
      if (!isPasskeyCancellation(caught)) setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="Confirm it is you"
      description="For your security, confirm your identity before changing sign-in or security settings."
      onClose={() => close(false)}
    >
      <form className="stack" onSubmit={(event) => void withPassword(event)}>
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        {me?.security.hasPassword === true ? (
          <>
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {needsCode ? (
              <TextField
                label="Authenticator or recovery code"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            ) : null}
            <Button type="submit" loading={busy} loadingLabel="Checking">
              Confirm with password
            </Button>
          </>
        ) : null}
        {me !== null && me.security.passkeyCount > 0 && passkeysSupported() ? (
          <Button variant="secondary" disabled={busy} onClick={() => void withPasskey()}>
            Confirm with passkey
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => close(false)}>
          Cancel
        </Button>
      </form>
    </Dialog>
  );
}
