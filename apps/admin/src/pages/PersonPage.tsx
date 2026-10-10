import { Alert, Button, Skeleton } from '@tessera/ui';
import { useCallback, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import { errorMessage } from '../api.js';
import { endpoints } from '../endpoints.js';
import { dateTime } from '../format.js';
import { useSession } from '../session.js';
import { useStepUp } from '../step-up.js';
import { useResource } from '../use-resource.js';

/**
 * A person's account metadata for the stated purpose. Never message content (the server has
 * none), password hashes, tokens, authenticator secrets or recovery codes. There is no way to act
 * as the person.
 */
export function PersonPage(): ReactNode {
  const { userId = '' } = useParams();
  const [params] = useSearchParams();
  const purpose = params.get('purpose') ?? '';
  const { can } = useSession();
  const { withStepUp } = useStepUp();
  const load = useCallback(() => endpoints.userDetail(userId, purpose), [userId, purpose]);
  const detail = useResource(load);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  async function act(action: () => Promise<string | undefined>) {
    setError(undefined);
    setNotice(undefined);
    try {
      const message = await action();
      if (message !== undefined) setNotice(message);
      detail.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const person = detail.data;
  return (
    <section className="stack">
      <p>
        <Link to="/people">← People</Link>
      </p>
      <h1>{person?.username ?? 'Account'}</h1>
      <p className="muted">Purpose: {purpose}</p>
      {detail.error === undefined ? null : <Alert tone="danger">{detail.error}</Alert>}
      {notice === undefined ? null : <Alert tone="success">{notice}</Alert>}
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {person === undefined ? (
        detail.error === undefined ? (
          <Skeleton width="100%" height="8rem" shape="tile" />
        ) : null
      ) : (
        <>
          <dl className="facts">
            <dt>Email</dt>
            <dd>{person.email}</dd>
            <dt>Account id</dt>
            <dd className="mono">{person.id}</dd>
            <dt>Status</dt>
            <dd>{person.status}</dd>
            <dt>Standing</dt>
            <dd>
              {person.standing.status}
              {person.standing.suspendedUntil === null
                ? ''
                : ` until ${dateTime(person.standing.suspendedUntil)}`}
            </dd>
            <dt>Created</dt>
            <dd>{dateTime(person.createdAt)}</dd>
            <dt>Sign-in methods</dt>
            <dd>
              {person.credentials.hasPassword ? 'password' : 'no password'} ·{' '}
              {person.credentials.passkeyCount} passkey(s) ·{' '}
              {person.credentials.totpEnabled ? 'authenticator app on' : 'no authenticator app'} ·{' '}
              {person.credentials.recoveryCodesRemaining} recovery codes left
            </dd>
          </dl>

          <div className="row">
            {can('usersRevokeSessions') ? (
              <Button
                variant="danger"
                onClick={() =>
                  void act(async () => {
                    const result = await withStepUp(() =>
                      endpoints.revokeSessions(userId, purpose),
                    );
                    return result === undefined
                      ? undefined
                      : `Signed out of ${String(result.revoked)} session(s).`;
                  })
                }
              >
                Sign out everywhere
              </Button>
            ) : null}
            {can('usersResendVerification') && person.status === 'pending_verification' ? (
              <Button
                variant="secondary"
                onClick={() =>
                  void act(async () => {
                    await endpoints.resendVerification(userId, purpose);
                    return 'Verification email sent again.';
                  })
                }
              >
                Resend verification email
              </Button>
            ) : null}
          </div>

          <h2>Sessions</h2>
          {person.sessions.length === 0 ? <p>No active sessions.</p> : null}
          <ul className="list">
            {person.sessions.map((session) => (
              <li key={session.id}>
                <span>
                  {session.userAgent} · {session.ipPrefix} · last seen{' '}
                  {dateTime(session.lastSeenAt)}
                </span>
                {can('usersRevokeSessions') ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void act(async () => {
                        const result = await withStepUp(() =>
                          endpoints.revokeSessions(userId, purpose, session.id),
                        );
                        return result === undefined ? undefined : 'Session signed out.';
                      })
                    }
                  >
                    Sign out
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>

          <h2>Devices</h2>
          {person.devices.length === 0 ? <p>No devices.</p> : null}
          <ul className="list">
            {person.devices.map((device) => (
              <li key={device.id}>
                {device.label} · added {dateTime(device.createdAt)}
              </li>
            ))}
          </ul>

          <h2>Recent sign-ins</h2>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Result</th>
                <th scope="col">Method</th>
                <th scope="col">Network</th>
              </tr>
            </thead>
            <tbody>
              {person.loginEvents.map((event) => (
                <tr key={`${event.createdAt}-${event.kind}`}>
                  <td>{dateTime(event.createdAt)}</td>
                  <td>{event.kind}</td>
                  <td>{event.method}</td>
                  <td>{event.ipPrefix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
