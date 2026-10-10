import { Alert, Skeleton } from '@tessera/ui';
import { useCallback, type ReactNode } from 'react';

import { endpoints } from '../endpoints.js';
import { useSession } from '../session.js';
import { useResource } from '../use-resource.js';

function Stat({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div className="stat">
      <p className="stat__value">{value.toLocaleString()}</p>
      <p className="stat__label">{label}</p>
    </div>
  );
}

/** Aggregates only — no person appears here. */
export function DashboardPage(): ReactNode {
  const { can } = useSession();
  const dashboard = useResource(endpoints.dashboard);
  const showSignups = can('analytics');
  const loadSignups = useCallback(
    () => (showSignups ? endpoints.signups(30) : Promise.resolve(null)),
    [showSignups],
  );
  const signups = useResource(loadSignups);
  const data = dashboard.data;
  return (
    <section className="stack">
      <h1>Dashboard</h1>
      {dashboard.error === undefined ? null : <Alert tone="danger">{dashboard.error}</Alert>}
      {data === undefined ? (
        <Skeleton width="100%" height="6rem" shape="tile" />
      ) : (
        <div className="stats">
          <Stat label="Accounts" value={data.users.total} />
          <Stat label="New in 24 h" value={data.users.newLast24h} />
          <Stat label="Active in 24 h" value={data.users.activeLast24h} />
          <Stat label="Messages in 24 h" value={data.messagesLast24h} />
          <Stat label="Open moderation cases" value={data.moderation.openCases} />
          <Stat label="Missed deadlines" value={data.moderation.missedDeadlines} />
          <Stat label="Pending approvals" value={data.pendingApprovals} />
          <Stat label="Notification queue" value={data.notificationQueue} />
        </div>
      )}
      {showSignups && signups.data !== undefined && signups.data !== null ? (
        <>
          <h2>Sign-ups per day</h2>
          <p className="muted">
            Days with fewer than {signups.data.threshold} sign-ups are not shown, so no one can be
            singled out.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Sign-ups</th>
              </tr>
            </thead>
            <tbody>
              {signups.data.days.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>{day.signups ?? `fewer than ${String(signups.data?.threshold)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
