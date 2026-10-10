import { Alert, Button, Skeleton } from '@tessera/ui';
import { useCallback, useState, type ReactNode } from 'react';

import { errorMessage } from '../api.js';
import { endpoints, type ApprovalStatus } from '../endpoints.js';
import { dateTime, roleName, until } from '../format.js';
import { useSession } from '../session.js';
import { useStepUp } from '../step-up.js';
import { useResource } from '../use-resource.js';

const STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'cancelled'];

function describe(payload: Record<string, unknown>, names: Map<string, string>): string {
  const who = (id: unknown) => names.get(String(id)) ?? String(id);
  switch (payload['kind']) {
    case 'role_grant':
      return `Give ${who(payload['adminId'])} the ${roleName(String(payload['role']))} role for ${String(payload['hours'])} h`;
    case 'eligibility':
      return `Let ${who(payload['adminId'])} request: ${(payload['roles'] as string[]).map(roleName).join(', ') || 'nothing'}`;
    case 'admin_create':
      return `Add admin ${String(payload['email'])} (${String(payload['displayName'])})`;
    case 'feature_flag':
      return `Set flag ${String(payload['key'])} ${payload['enabled'] === true ? `on for ${String(payload['rolloutPercent'])}%` : 'off'}`;
    case 'staff_role':
      return `Give @${String(payload['username'])} the ${roleName(String(payload['role']))} role for ${String(payload['days'])} days`;
    default:
      return String(payload['kind']);
  }
}

/** Four eyes: requests from other admins wait here for a second person. */
export function ApprovalsPage(): ReactNode {
  const { me, can } = useSession();
  const { withStepUp } = useStepUp();
  const [status, setStatus] = useState<ApprovalStatus>('pending');
  const load = useCallback(() => endpoints.approvals(status), [status]);
  const approvals = useResource(load);
  const canSeeAdmins = can('adminsView');
  const loadAdmins = useCallback(
    () => (canSeeAdmins ? endpoints.admins() : Promise.resolve({ admins: [] })),
    [canSeeAdmins],
  );
  const admins = useResource(loadAdmins);
  const names = new Map((admins.data?.admins ?? []).map((a) => [a.id, a.email]));
  if (me !== null) names.set(me.id, `${me.email} (you)`);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();

  async function decide(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
      approvals.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="stack">
      <h1>Approvals</h1>
      <p className="muted">
        Role grants, eligibility, new admins, feature flags and moderation roles take effect only
        when a second admin approves them within 24 hours. Nobody approves their own request.
      </p>
      <div className="row" role="group" aria-label="Show">
        {STATUSES.map((value) => (
          <Button
            key={value}
            size="sm"
            variant={status === value ? 'primary' : 'secondary'}
            aria-pressed={status === value}
            onClick={() => {
              setStatus(value);
            }}
          >
            {value[0]?.toUpperCase()}
            {value.slice(1)}
          </Button>
        ))}
      </div>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {approvals.error === undefined ? null : <Alert tone="danger">{approvals.error}</Alert>}
      {approvals.data === undefined ? <Skeleton width="100%" height="4rem" /> : null}
      {approvals.data?.approvals.length === 0 ? <p>Nothing {status}.</p> : null}
      <ul className="list">
        {approvals.data?.approvals.map((approval) => {
          const mine = approval.requestedBy === me?.id;
          const note = notes[approval.id] ?? '';
          return (
            <li
              key={approval.id}
              className="card stack"
              aria-label={describe(approval.payload, names)}
            >
              <p>
                <strong>{describe(approval.payload, names)}</strong>
              </p>
              <p className="muted">
                Asked by {names.get(approval.requestedBy) ?? approval.requestedBy} ·{' '}
                {dateTime(approval.requestedAt)} · “{approval.reason}”
                {approval.status === 'pending' ? ` · expires ${until(approval.expiresAt)}` : ''}
              </p>
              {approval.status !== 'pending' && approval.decidedBy !== null ? (
                <p className="muted">
                  {approval.status} by {names.get(approval.decidedBy) ?? approval.decidedBy}
                  {approval.decisionNote === '' ? '' : ` — “${approval.decisionNote}”`}
                </p>
              ) : null}
              {approval.status === 'pending' && !mine ? (
                <div className="row">
                  <label className="t-field">
                    <span className="t-field__label">Note (optional)</span>
                    <input
                      className="t-field__input"
                      maxLength={500}
                      value={note}
                      onChange={(event) => {
                        setNotes({ ...notes, [approval.id]: event.target.value });
                      }}
                    />
                  </label>
                  <Button
                    onClick={() =>
                      void decide(() => withStepUp(() => endpoints.approve(approval.id, note)))
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void decide(() => endpoints.reject(approval.id, note))}
                  >
                    Reject
                  </Button>
                </div>
              ) : null}
              {approval.status === 'pending' && mine ? (
                <div className="row">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void decide(() => endpoints.cancel(approval.id))}
                  >
                    Withdraw
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
