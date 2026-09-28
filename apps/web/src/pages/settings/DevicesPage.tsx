import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import { MAX_DEVICES } from '@tessera/validation';
import { useCallback, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { PageHeading } from '../../components/PageHeading.js';
import { WorkerCryptoError } from '../../crypto/client.js';
import type { E2eeSession, PendingLink } from '../../messaging/e2ee.js';
import { useE2ee } from '../../messaging/provider.js';
import { useResource } from '../../lib/use-resource.js';
import { isPasskeyCancellation, passkeysSupported } from '../../lib/webauthn.js';
import { useStepUp } from '../../state/step-up.js';

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Section(props: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={props.id}>
      <h2 id={props.id}>{props.title}</h2>
      <p className="settings-section__description">{props.description}</p>
      {props.children}
    </section>
  );
}

/** Devices that can read this account's encrypted messages, linking, and backups. */
export function DevicesPage(): ReactNode {
  const session = useE2ee();
  const ready = session?.status === 'ready';
  return (
    <div className="settings-page">
      <PageHeading description="Every device listed here can read your end-to-end encrypted messages.">
        Devices and backups
      </PageHeading>
      {session === null || session.status === 'starting' ? (
        <div role="status" aria-busy="true" aria-label="Loading" className="stack">
          <Skeleton height="3rem" shape="tile" />
        </div>
      ) : !ready ? (
        <Alert tone="info">
          Encryption is not set up on this device yet. <Link to="/chats">Set it up in Chats</Link>{' '}
          first.
        </Alert>
      ) : (
        <>
          <DeviceList session={session} />
          <LinkDevice session={session} />
          <Backups session={session} />
        </>
      )}
    </div>
  );
}

function DeviceList({ session }: { session: E2eeSession }): ReactNode {
  const { withStepUp } = useStepUp();
  const load = useCallback(() => session.devices(), [session]);
  const resource = useResource(load);
  const [actionError, setError] = useState<string>();
  const error = actionError ?? resource.error;
  const devices = resource.data?.devices;

  async function remove(deviceId: string, label: string) {
    if (
      !window.confirm(
        `Remove “${label}”? It will no longer receive new messages. If it has full access, also consider creating a new security key.`,
      )
    )
      return;
    setError(undefined);
    try {
      const result = await session.revokeDevice(deviceId, withStepUp);
      if (result !== undefined) resource.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Section
      id="devices"
      title="Your devices"
      description={`You can use encrypted chats on up to ${MAX_DEVICES} devices. Remove any you don’t recognise.`}
    >
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {devices === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading devices" className="stack">
          <Skeleton height="3rem" shape="tile" />
        </div>
      ) : (
        <ul className="item-list" aria-label="Devices">
          {devices.map((device) => {
            const current = device.deviceId === session.deviceId;
            return (
              <li key={device.deviceId} className="item">
                <div>
                  <p className="item__title">
                    {device.label}
                    {current ? <span className="badge">This device</span> : null}
                  </p>
                  <p className="item__meta">
                    {device.trusted ? 'Full access' : 'Messages only'} · added{' '}
                    {dateTime.format(new Date(device.createdAt))} · last active{' '}
                    {dateTime.format(new Date(device.lastSeenAt))}
                  </p>
                </div>
                {current ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove device ${device.label}`}
                    onClick={() => void remove(device.deviceId, device.label)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function linkError(caught: unknown): string {
  if (caught instanceof WorkerCryptoError) {
    if (caught.code === 'UNTRUSTED')
      return 'The code does not match the device that asked to be linked. Check the code on the new device and type it again.';
    if (caught.code === 'MALFORMED')
      return 'That is not a valid link code. Check it and try again.';
  }
  return errorMessage(caught);
}

function LinkDevice({ session }: { session: E2eeSession }): ReactNode {
  const { withStepUp } = useStepUp();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<PendingLink>();
  const [trusted, setTrusted] = useState(true);
  const [history, setHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string }>();

  if (!session.trusted)
    return (
      <Section
        id="link"
        title="Link a new device"
        description="Only devices with full access can link new devices."
      >
        <p className="empty">This device has “messages only” access.</p>
      </Section>
    );

  async function find(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    try {
      setPending(await session.lookupLink(code));
    } catch (caught) {
      setMessage({
        tone: 'danger',
        text:
          caught instanceof WorkerCryptoError
            ? linkError(caught)
            : 'No device is waiting with that code. Codes expire after 3 minutes.',
      });
    }
    setBusy(false);
  }

  async function approve() {
    if (pending === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const done = await session.approveLink(pending, trusted, history, withStepUp);
      if (done) {
        setMessage({ tone: 'success', text: `“${pending.label}” is now linked.` });
        setPending(undefined);
        setCode('');
      }
    } catch (caught) {
      setMessage({ tone: 'danger', text: linkError(caught) });
    }
    setBusy(false);
  }

  return (
    <Section
      id="link"
      title="Link a new device"
      description="On the new device, choose “Link from another device” and type the code it shows here."
    >
      {message === undefined ? null : <Alert tone={message.tone}>{message.text}</Alert>}
      {pending === undefined ? (
        <form className="stack" onSubmit={(event) => void find(event)}>
          <TextField
            label="Link code"
            hint="24 letters and numbers, shown on the new device."
            required
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div>
            <Button type="submit" variant="secondary" loading={busy} loadingLabel="Looking up">
              Continue
            </Button>
          </div>
        </form>
      ) : (
        <div className="stack">
          <p>
            <strong>{pending.label}</strong> wants to use your encrypted chats. Only continue if it
            is your device and you are holding it now.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={trusted}
              onChange={(e) => setTrusted(e.target.checked)}
            />
            <span>
              Full access — it gets your security key, so it can link other devices and make
              backups. Leave unticked for a shared or less trusted device.
            </span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={history}
              onChange={(e) => setHistory(e.target.checked)}
            />
            <span>Transfer message history from this device (end-to-end encrypted)</span>
          </label>
          <div className="button-row">
            <Button loading={busy} loadingLabel="Linking" onClick={() => void approve()}>
              Link device
            </Button>
            <Button variant="ghost" onClick={() => setPending(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function RecoveryKey({ value, onDone }: { value: string; onDone: () => void }): ReactNode {
  const [saved, setSaved] = useState(false);
  return (
    <Alert tone="warning" title="Save your recovery key">
      <p>
        It unlocks your backups if you lose all your devices. Store it somewhere safe, like a
        password manager. It will not be shown again, and Tessera cannot recover it for you.
      </p>
      <p className="recovery-key">
        <code data-testid="recovery-key">{value}</code>
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I have saved my recovery key</span>
      </label>
      <Button size="sm" disabled={!saved} onClick={onDone}>
        Done
      </Button>
    </Alert>
  );
}

function Backups({ session }: { session: E2eeSession }): ReactNode {
  const { withStepUp } = useStepUp();
  const load = useCallback(() => session.backupStatus(), [session]);
  const resource = useResource(load);
  const status = resource.data;
  const [recoveryKey, setRecoveryKey] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger' | 'info'; text: string }>();
  const on = status !== undefined && status.wraps.length > 0;

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    setMessage(undefined);
    try {
      await action();
      resource.reload();
    } catch (caught) {
      if (!isPasskeyCancellation(caught))
        setMessage({ tone: 'danger', text: errorMessage(caught) });
    }
    setBusy(null);
  }

  const enable = () =>
    void run('enable', async () => {
      const key = await session.enableBackups(withStepUp);
      if (key !== null) setRecoveryKey(key);
    });
  const backupNow = () =>
    void run('now', async () => {
      const result = await session.backupNow();
      setMessage(
        result === 'uploaded'
          ? { tone: 'success', text: 'Backup complete.' }
          : result === 'not-owner'
            ? {
                tone: 'info',
                text: 'Backups were turned on again on another device. Link this device from it to back up from here.',
              }
            : { tone: 'info', text: 'Backups are off.' },
      );
    });
  const newKey = () =>
    void run('key', async () => {
      if (!window.confirm('Create a new recovery key? The current one will stop working.')) return;
      const key = await session.newRecoveryKey(withStepUp);
      if (key !== null) setRecoveryKey(key);
    });
  const addPasskey = () =>
    void run('passkey', async () => {
      if (await session.addPasskeyUnlock(withStepUp))
        setMessage({ tone: 'success', text: 'Your passkey can now unlock backups.' });
    });
  const removeKey = (id: string) =>
    run(`remove-${id}`, async () => {
      if (!window.confirm('This passkey will no longer unlock your backups. Continue?')) return;
      await session.removeBackupKey(id, withStepUp);
    });
  const disable = () =>
    void run('disable', async () => {
      if (!window.confirm('Turn off backups and delete every backup from the server?')) return;
      if (await session.disableBackups(withStepUp))
        setMessage({ tone: 'info', text: 'Backups are off and were deleted.' });
    });

  const canManage = session.trusted && session.backupsEnabled;

  return (
    <Section
      id="backups"
      title="Encrypted backups"
      description="Backups are encrypted on this device before upload. Only your recovery key or a passkey you choose can unlock them — not Tessera."
    >
      {recoveryKey === undefined ? null : (
        <RecoveryKey value={recoveryKey} onDone={() => setRecoveryKey(undefined)} />
      )}
      {message === undefined ? null : <Alert tone={message.tone}>{message.text}</Alert>}
      {resource.error === undefined ? null : <Alert tone="danger">{resource.error}</Alert>}
      {status === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading backups" className="stack">
          <Skeleton height="3rem" shape="tile" />
        </div>
      ) : !on ? (
        <div className="stack">
          <p className="empty">Backups are off.</p>
          {session.trusted ? (
            <div>
              <Button loading={busy === 'enable'} loadingLabel="Turning on" onClick={enable}>
                Turn on backups
              </Button>
            </div>
          ) : (
            <p className="item__meta">Only a device with full access can turn on backups.</p>
          )}
        </div>
      ) : (
        <div className="stack">
          <p role="status">
            {status.latest === null
              ? 'No backup yet.'
              : `Last backup ${dateTime.format(new Date(status.latest.createdAt))} (${Math.max(1, Math.round(status.latest.size / 1024))} KB).`}
            {canManage ? ' This device backs up automatically once a day.' : ''}
          </p>
          <ul className="item-list" aria-label="Ways to unlock backups">
            {status.wraps.map((wrap) => (
              <li key={wrap.id} className="item">
                <div>
                  <p className="item__title">
                    {wrap.kind === 'recovery' ? 'Recovery key' : 'Passkey'}
                  </p>
                  <p className="item__meta">Added {dateTime.format(new Date(wrap.createdAt))}</p>
                </div>
                {wrap.kind === 'passkey' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busy === `remove-${wrap.id}`}
                    loadingLabel="Removing"
                    onClick={() => void removeKey(wrap.id)}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {canManage ? (
            <div className="button-row">
              <Button
                variant="secondary"
                loading={busy === 'now'}
                loadingLabel="Backing up"
                onClick={backupNow}
              >
                Back up now
              </Button>
              <Button
                variant="secondary"
                loading={busy === 'key'}
                loadingLabel="Creating"
                onClick={newKey}
              >
                New recovery key
              </Button>
              {passkeysSupported() ? (
                <Button
                  variant="secondary"
                  loading={busy === 'passkey'}
                  loadingLabel="Waiting for your passkey"
                  onClick={addPasskey}
                >
                  Unlock with a passkey
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="item__meta">
              Backups are made by the device that turned them on and devices linked from it with
              full access.
            </p>
          )}
          <div>
            <Button
              variant="danger"
              loading={busy === 'disable'}
              loadingLabel="Turning off"
              onClick={disable}
            >
              Turn off and delete backups
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}
