import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import { useEffect, useState, type ReactNode, type SubmitEvent } from 'react';

import { errorMessage } from '../../api/client.js';
import { WorkerCryptoError } from '../../crypto/client.js';
import type { DeviceStatus } from '../../messaging/e2ee.js';
import { useE2ee, useMessagingStore } from '../../messaging/provider.js';
import {
  PrfUnsupportedError,
  defaultPasskeyName,
  isPasskeyCancellation,
  passkeysSupported,
} from '../../lib/webauthn.js';
import { useStepUp } from '../../state/step-up.js';

/**
 * Shown instead of chats until this device can take part in end-to-end encryption
 * (docs/e2ee.md §9, docs/multi-device.md §3, docs/encrypted-backups.md §5).
 */
export function EncryptionSetup({ status }: { status: DeviceStatus }): ReactNode {
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

  if (status === 'revoked') return <Revoked />;
  return <SetupChoices />;
}

function Revoked(): ReactNode {
  const session = useE2ee();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function forget() {
    if (session === null) return;
    if (
      !window.confirm(
        'Delete the encrypted messages and keys stored on this device? Other devices are not affected.',
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await session.forgetDevice();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <section className="encryption-setup" aria-labelledby="setup-heading">
      <h2 id="setup-heading">This device was removed from your encrypted chats</h2>
      <p>
        It was removed on another device, or your security key was replaced. It can no longer read
        or send messages. Messages already on this device stay readable here until you delete them.
      </p>
      <p>To use encrypted chats here again, delete this device’s data and set it up again.</p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <div>
        <Button
          variant="danger"
          loading={busy}
          loadingLabel="Deleting"
          onClick={() => void forget()}
        >
          Delete this device’s data
        </Button>
      </div>
    </section>
  );
}

type Choice = 'link' | 'restore' | 'new';

function SetupChoices(): ReactNode {
  const [choice, setChoice] = useState<Choice>('link');
  return (
    <section className="encryption-setup" aria-labelledby="setup-heading">
      <h2 id="setup-heading">Set up encryption on this device</h2>
      <p>Your account’s security key is on another device. Choose how to bring it to this one.</p>
      <div className="segmented" role="group" aria-label="How to set up this device">
        {(
          [
            ['link', 'Link from another device'],
            ['restore', 'Restore from backup'],
            ['new', 'Start over'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={choice === value}
            className="segmented__option"
            onClick={() => setChoice(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {choice === 'link' ? <LinkPanel /> : choice === 'restore' ? <RestorePanel /> : <NewKey />}
    </section>
  );
}

function useCountdown(until: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until === undefined ? 0 : Math.max(0, Math.round((Date.parse(until) - now) / 1000));
}

function LinkPanel(): ReactNode {
  const session = useE2ee();
  const [label, setLabel] = useState(defaultPasskeyName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const link = session?.link ?? null;
  const seconds = useCountdown(link?.phase === 'waiting' ? link.expiresAt : undefined);

  useEffect(() => {
    if (link?.phase === 'waiting' && seconds === 0) void session?.checkLink();
  }, [link?.phase, seconds, session]);

  async function start(event?: SubmitEvent) {
    event?.preventDefault();
    if (session === null) return;
    setBusy(true);
    setError(undefined);
    try {
      await session.startLink(label.trim());
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  if (link !== null && link.phase !== 'expired') {
    return (
      <div className="stack">
        {link.phase === 'failed' ? (
          <Alert tone="danger" title="Linking failed">
            The other device’s answer could not be verified, so nothing was set up. Try again.
          </Alert>
        ) : null}
        {link.phase === 'completing' || link.phase === 'done' ? (
          <p role="status" aria-busy="true">
            Approved. Setting up this device…
          </p>
        ) : null}
        {link.phase === 'waiting' ? (
          <>
            <p>
              On a device where you already use Tessera, open{' '}
              <strong>Settings → Devices → Link a new device</strong> and type this code:
            </p>
            <p className="link-code" aria-label="Link code">
              <code data-testid="link-code">{link.code}</code>
            </p>
            <p className="item__meta" role="status" aria-live="off">
              Waiting for approval · expires in {Math.floor(seconds / 60)}:
              {String(seconds % 60).padStart(2, '0')}
            </p>
            <p className="item__meta">
              Only type this code on your own devices. Nobody from Tessera will ever ask for it.
            </p>
          </>
        ) : null}
        <div className="button-row">
          {link.phase === 'failed' ? (
            <Button onClick={() => void start()}>Get a new code</Button>
          ) : null}
          <Button variant="ghost" onClick={() => session?.cancelLink()}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={(event) => void start(event)}>
      {link?.phase === 'expired' ? (
        <Alert tone="warning">The code expired before it was approved. Get a new one.</Alert>
      ) : null}
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <p>
        Your other device sends this one your security key — end-to-end encrypted, the server cannot
        read it — and, if you choose, your message history.
      </p>
      <TextField
        label="Name for this device"
        hint="Shown in your device list."
        required
        maxLength={80}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <div>
        <Button type="submit" loading={busy} loadingLabel="Preparing">
          Show link code
        </Button>
      </div>
    </form>
  );
}

function restoreError(caught: unknown): string {
  if (caught instanceof PrfUnsupportedError) return caught.message;
  if (caught instanceof WorkerCryptoError) {
    if (caught.message.includes('older security key'))
      return 'This backup was made with an older security key of your account, so it cannot be restored.';
    if (caught.message.includes('wrong recovery key') || caught.code === 'MALFORMED')
      return 'That recovery key or passkey does not unlock your backup. Check it and try again.';
    return 'The backup is damaged or was changed, so it was not restored.';
  }
  return errorMessage(caught);
}

function RestorePanel(): ReactNode {
  const session = useE2ee();
  const [recoveryKey, setRecoveryKey] = useState('');
  const [busy, setBusy] = useState<'recovery' | 'passkey' | null>(null);
  const [error, setError] = useState<string>();

  async function restore(kind: 'recovery' | 'passkey', event?: SubmitEvent) {
    event?.preventDefault();
    if (session === null) return;
    setBusy(kind);
    setError(undefined);
    try {
      await session.restoreFromBackup(
        kind === 'recovery' ? { kind, recoveryKey } : { kind },
        defaultPasskeyName(),
      );
      setRecoveryKey('');
    } catch (caught) {
      if (!isPasskeyCancellation(caught)) setError(restoreError(caught));
    }
    setBusy(null);
  }

  return (
    <div className="stack">
      <p>
        Restores your security key, verified contacts and message history from your latest encrypted
        backup. The backup is unlocked here, in this browser.
      </p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <form className="stack" onSubmit={(event) => void restore('recovery', event)}>
        <TextField
          label="Recovery key"
          hint="52 letters and numbers, in groups of four."
          required
          autoComplete="off"
          spellCheck={false}
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.target.value)}
        />
        <div>
          <Button type="submit" loading={busy === 'recovery'} loadingLabel="Restoring">
            Restore with recovery key
          </Button>
        </div>
      </form>
      {passkeysSupported() ? (
        <div>
          <Button
            variant="secondary"
            loading={busy === 'passkey'}
            loadingLabel="Waiting for your passkey"
            onClick={() => void restore('passkey')}
          >
            Restore with a passkey
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function NewKey(): ReactNode {
  const session = useE2ee();
  const { withStepUp } = useStepUp();
  const store = useMessagingStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function reset() {
    if (session === null) return;
    setBusy(true);
    setError(undefined);
    try {
      const done = await session.resetIdentity(withStepUp);
      if (done) await store?.resume();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <div className="stack">
      <p>Only if you no longer have another device or a backup. A new security key will:</p>
      <ul>
        <li>sign every other device out of your encrypted chats;</li>
        <li>show your contacts a notice that your security key changed;</li>
        <li>
          not bring back messages from before — they stay only on the devices that received them.
        </li>
      </ul>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <div>
        <Button
          variant="danger"
          loading={busy}
          loadingLabel="Setting up"
          onClick={() => void reset()}
        >
          Create a new security key
        </Button>
      </div>
    </div>
  );
}
