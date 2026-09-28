import type { SessionSummary } from '@tessera/validation';
import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import QRCode from 'qrcode';
import { useState, type ReactNode, type SubmitEvent } from 'react';
import { useLocation } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';
import {
  createPasskey,
  defaultPasskeyName,
  isPasskeyCancellation,
  passkeysSupported,
} from '../../lib/webauthn.js';
import { useResource } from '../../lib/use-resource.js';
import { useSession } from '../../state/session.js';
import { useStepUp } from '../../state/step-up.js';

const loadPasskeys = () => endpoints.passkeys();
const loadSessions = () => endpoints.sessions();

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <p className="settings-section__description">{description}</p>
      {children}
    </section>
  );
}

function PasswordSection() {
  const { me, refresh } = useSession();
  const { withStepUp } = useStepUp();
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string }>();
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    try {
      const done = await withStepUp(() => endpoints.changePassword(password));
      if (done !== undefined) {
        setPassword('');
        setMessage({
          tone: 'success',
          text: 'Password saved. Your other sessions were signed out.',
        });
        await refresh();
      }
    } catch (caught) {
      setMessage({ tone: 'danger', text: errorMessage(caught) });
    }
    setBusy(false);
  }

  return (
    <Section
      id="password"
      title="Password"
      description={
        me?.security.hasPassword === true
          ? 'Changing your password signs out your other sessions.'
          : 'You sign in with passkeys. You can also add a password.'
      }
    >
      <form className="stack" onSubmit={(event) => void submit(event)}>
        {message === undefined ? null : <Alert tone={message.tone}>{message.text}</Alert>}
        <TextField
          label={me?.security.hasPassword === true ? 'New password' : 'Password'}
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div>
          <Button type="submit" variant="secondary" loading={busy} loadingLabel="Saving">
            {me?.security.hasPassword === true ? 'Change password' : 'Add password'}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function PasskeysSection() {
  const { refresh } = useSession();
  const { withStepUp } = useStepUp();
  const resource = useResource(loadPasskeys);
  const passkeys = resource.data?.passkeys;
  const [actionError, setError] = useState<string>();
  const error = actionError ?? resource.error;
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    setError(undefined);
    try {
      const flow = await withStepUp(() => endpoints.passkeyRegisterOptions());
      if (flow !== undefined) {
        await endpoints.passkeyRegisterVerify(
          flow.flowId,
          defaultPasskeyName(),
          await createPasskey(flow.options),
        );
        resource.reload();
        await refresh();
      }
    } catch (caught) {
      if (!isPasskeyCancellation(caught)) setError(errorMessage(caught));
    }
    setBusy(false);
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Remove the passkey “${name}”?`)) return;
    setError(undefined);
    try {
      await withStepUp(() => endpoints.deletePasskey(id));
      resource.reload();
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Section
      id="passkeys"
      title="Passkeys"
      description="Phishing-resistant sign-in with your fingerprint, face or device PIN."
    >
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {passkeys === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading passkeys" className="stack">
          <Skeleton height="3rem" shape="tile" />
        </div>
      ) : passkeys.length === 0 ? (
        <p className="empty">No passkeys yet.</p>
      ) : (
        <ul className="item-list">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="item">
              <div>
                <p className="item__title">{passkey.name}</p>
                <p className="item__meta">
                  Added {dateTime.format(new Date(passkey.createdAt))}
                  {passkey.lastUsedAt === null
                    ? ''
                    : ` · last used ${dateTime.format(new Date(passkey.lastUsedAt))}`}
                  {passkey.synced ? ' · synced' : ''}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void remove(passkey.id, passkey.name)}
                aria-label={`Remove passkey ${passkey.name}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {passkeysSupported() ? (
        <div>
          <Button
            variant="secondary"
            loading={busy}
            loadingLabel="Waiting for your device"
            onClick={() => void add()}
          >
            Add a passkey
          </Button>
        </div>
      ) : (
        <Alert tone="info">This browser does not support passkeys.</Alert>
      )}
    </Section>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <Alert tone="warning" title="Save your recovery codes">
      <p>
        Each code signs you in once if you lose your authenticator. They will not be shown again.
      </p>
      <ol className="recovery-codes" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <Button size="sm" onClick={onDone}>
        I have saved them
      </Button>
    </Alert>
  );
}

function TwoFactorSection() {
  const { me, refresh } = useSession();
  const { withStepUp } = useStepUp();
  const [setup, setSetup] = useState<{ secret: string; qr: string }>();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const enabled = me?.security.totpEnabled === true;

  async function begin() {
    setError(undefined);
    try {
      const result = await withStepUp(() => endpoints.totpSetup());
      if (result !== undefined)
        setSetup({
          secret: result.secret,
          qr: await QRCode.toDataURL(result.otpauthUri, { margin: 1, width: 192 }),
        });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function confirm(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await withStepUp(() => endpoints.totpConfirm(code.trim()));
      if (result !== undefined) {
        setCodes(result.recoveryCodes);
        setSetup(undefined);
        setCode('');
        await refresh();
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  async function disable() {
    if (
      !window.confirm(
        'Turn off two-step verification? Your account will be protected by one factor only.',
      )
    )
      return;
    setError(undefined);
    try {
      if ((await withStepUp(() => endpoints.totpDisable())) !== undefined) await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function regenerate() {
    setError(undefined);
    try {
      const result = await withStepUp(() => endpoints.regenerateRecoveryCodes());
      if (result !== undefined) {
        setCodes(result.recoveryCodes);
        await refresh();
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Section
      id="two-step"
      title="Two-step verification"
      description="Require a code from an authenticator app in addition to your password."
    >
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {codes === undefined ? null : (
        <RecoveryCodes codes={codes} onDone={() => setCodes(undefined)} />
      )}
      {enabled ? (
        <div className="stack">
          <p>
            <strong>On.</strong> {me.security.recoveryCodesRemaining} recovery codes left.
          </p>
          <div className="button-row">
            <Button variant="secondary" size="sm" onClick={() => void regenerate()}>
              New recovery codes
            </Button>
            <Button variant="danger" size="sm" onClick={() => void disable()}>
              Turn off
            </Button>
          </div>
        </div>
      ) : setup === undefined ? (
        <div>
          <Button variant="secondary" onClick={() => void begin()}>
            Set up authenticator app
          </Button>
        </div>
      ) : (
        <form className="stack" onSubmit={(event) => void confirm(event)}>
          <ol className="steps">
            <li>Scan this QR code with an authenticator app.</li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>
          <img
            src={setup.qr}
            width={192}
            height={192}
            alt="QR code for your authenticator app"
            className="qr"
          />
          <p className="item__meta">
            Can’t scan? Enter this key: <code className="secret">{setup.secret}</code>
          </p>
          <TextField
            label="Code from the app"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div className="button-row">
            <Button type="submit" loading={busy} loadingLabel="Verifying">
              Turn on
            </Button>
            <Button variant="ghost" onClick={() => setSetup(undefined)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function SessionsSection() {
  const resource = useResource(loadSessions);
  const sessions: SessionSummary[] | undefined = resource.data?.sessions;
  const [actionError, setError] = useState<string>();
  const error = actionError ?? resource.error;
  const [notice, setNotice] = useState<string>();

  async function revoke(id: string) {
    setError(undefined);
    try {
      await endpoints.revokeSession(id);
      resource.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function revokeOthers() {
    setError(undefined);
    try {
      const { revoked } = await endpoints.revokeOtherSessions();
      setNotice(
        revoked === 1 ? 'Signed out 1 other session.' : `Signed out ${revoked} other sessions.`,
      );
      resource.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Section
      id="sessions"
      title="Where you are signed in"
      description="Sign out anything you do not recognise."
    >
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {notice === undefined ? null : <Alert tone="success">{notice}</Alert>}
      {sessions === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading sessions" className="stack">
          <Skeleton height="3rem" shape="tile" />
          <Skeleton height="3rem" shape="tile" />
        </div>
      ) : (
        <ul className="item-list">
          {sessions.map((session) => (
            <li key={session.id} className="item">
              <div>
                <p className="item__title">
                  {session.userAgent}
                  {session.current ? <span className="badge">This device</span> : null}
                </p>
                <p className="item__meta">
                  {session.approximateLocation ?? 'Unknown network'} · active{' '}
                  {dateTime.format(new Date(session.lastSeenAt))}
                </p>
              </div>
              {session.current ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void revoke(session.id)}
                  aria-label={`Sign out ${session.userAgent}`}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {sessions !== undefined && sessions.length > 1 ? (
        <div>
          <Button variant="secondary" onClick={() => void revokeOthers()}>
            Sign out all other sessions
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

export function SecurityPage(): ReactNode {
  const welcome = (useLocation().state as { welcome?: boolean } | null)?.welcome === true;
  return (
    <div className="settings-page">
      <PageHeading description="Control how you sign in and where your account is used.">
        Security
      </PageHeading>
      {welcome ? (
        <Alert tone="success" title="Your account is ready">
          Consider adding two-step verification or a second passkey below.
        </Alert>
      ) : null}
      <PasskeysSection />
      <PasswordSection />
      <TwoFactorSection />
      <SessionsSection />
    </div>
  );
}
