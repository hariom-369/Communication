import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import { STAFF_ROLE_VALUES } from '@tessera/validation';
import { useState, type ReactNode } from 'react';

import { errorMessage } from '../api.js';
import { ChangeRequest, Select } from '../components/ChangeRequest.js';
import { endpoints } from '../endpoints.js';
import { roleName, until } from '../format.js';
import { useSession } from '../session.js';
import { useStepUp } from '../step-up.js';
import { useResource } from '../use-resource.js';

type StaffRole = (typeof STAFF_ROLE_VALUES)[number];

/**
 * Moderation roles held by user accounts (they work in the in-app moderation console). Granting
 * is a four-eyes request; removing a role is immediate.
 */
export function StaffPage(): ReactNode {
  const { can, me } = useSession();
  const { withStepUp } = useStepUp();
  const staff = useResource(endpoints.staff);
  const [error, setError] = useState<string>();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<StaffRole>('moderator');
  const [days, setDays] = useState('90');
  const isSuper = me?.roles.some((r) => r.role === 'super_admin') === true;

  async function revoke(userId: string, staffRole: StaffRole) {
    setError(undefined);
    try {
      await withStepUp(() => endpoints.revokeStaff(userId, staffRole));
      staff.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="stack">
      <h1>Staff roles</h1>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {staff.error === undefined ? null : <Alert tone="danger">{staff.error}</Alert>}
      {staff.data === undefined ? <Skeleton width="100%" height="4rem" /> : null}
      {staff.data?.staff.length === 0 ? <p>No one holds a moderation role.</p> : null}
      <ul className="list">
        {staff.data?.staff.map((entry) => (
          <li key={`${entry.userId}-${entry.role}`}>
            <span>
              @{entry.username} · {roleName(entry.role)} · ends {until(entry.expiresAt)} · granted
              by {entry.grantedBy}
            </span>
            {can('staffRevoke') ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => void revoke(entry.userId, entry.role)}
              >
                Remove {roleName(entry.role)} from @{entry.username}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {isSuper ? (
        <ChangeRequest
          title="Give someone a moderation role"
          submitLabel="Request staff role"
          build={() => ({
            kind: 'staff_role',
            username: username.trim().replace(/^@/, ''),
            role,
            days: Number(days),
          })}
          onRequested={() => {
            setUsername('');
          }}
        >
          <TextField
            label="Username"
            required
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
          />
          <Select
            label="Role"
            value={role}
            options={STAFF_ROLE_VALUES.map((value) => ({ value, label: roleName(value) }))}
            onChange={setRole}
          />
          <TextField
            label="Days"
            type="number"
            min={1}
            max={90}
            required
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
            }}
          />
        </ChangeRequest>
      ) : null}
    </section>
  );
}
