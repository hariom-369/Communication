import { Alert, Button, Skeleton } from '@tessera/ui';
import { useState, type ReactNode } from 'react';

import { errorMessage } from '../../api/client.js';
import type { DeviceStatus } from '../../messaging/e2ee.js';
import { useMessagingStore } from '../../messaging/provider.js';
import { useStepUp } from '../../state/step-up.js';

/**
 * Shown instead of chats until this device can take part in end-to-end encryption
 * (docs/e2ee.md §9, ADR-040).
 */
export function EncryptionSetup({ status }: { status: DeviceStatus }): ReactNode {
  const store = useMessagingStore();
  const { withStepUp } = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (status === 'starting')
    return (
      <div className="encryption-setup" aria-busy="true">
        <p>Preparing end-to-end encryption on this device…</p>
        <Skeleton width="20rem" />
        <Skeleton width="16rem" />
      </div>
    );

  if (status === 'error')
    return (
      <div className="encryption-setup">
        <Alert tone="danger">
          Encryption could not start on this device. Check your connection and reload the page.
        </Alert>
      </div>
    );

  async function reset() {
    if (store === null) return;
    setBusy(true);
    setError(undefined);
    try {
      const done = await store.security.resetIdentity(withStepUp);
      if (done) await store.resume();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <section className="encryption-setup" aria-labelledby="setup-heading">
      <h2 id="setup-heading">
        {status === 'revoked'
          ? 'This device was signed out of encrypted chats'
          : 'Set up encryption on this device'}
      </h2>
      <p>
        {status === 'revoked'
          ? 'Your security key was replaced on another device, so this device can no longer read or send messages.'
          : 'Your account’s security key is on another device. Linking devices is not available yet, so this device needs a new security key.'}
      </p>
      <p>Creating a new security key on this device will:</p>
      <ul>
        <li>sign every other device out of your encrypted chats;</li>
        <li>show your contacts a notice that your security key changed;</li>
        <li>
          not bring back messages from before — they stay only on the devices that received them.
        </li>
      </ul>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <Button loading={busy} loadingLabel="Setting up" onClick={() => void reset()}>
        Create a new security key
      </Button>
    </section>
  );
}
