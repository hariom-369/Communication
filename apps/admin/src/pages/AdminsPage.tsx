import { Alert, Button, Skeleton, TextField, VisuallyHidden } from '@tessera/ui';
import { ADMIN_ROLES, MAX_ELEVATED_HOURS, type AdminRole } from '@tessera/validation';
import { useState, type ReactNode } from 'react';

import { errorMessage } from '../api.js';
import { ChangeRequest, Select } from '../components/ChangeRequest.js';
import { endpoints } from '../endpoints.js';
import { roleName, until } from '../format.js';
import { useSession } from '../session.js';
import { useStepUp } from '../step-up.js';
import { useResource } from '../use-resource.js';

const ELEVATED = new Set<AdminRole>(['super_admin', 'security_admin']);

/** Admin accounts. Adding admins and granting roles are four-eyes requests; disabling is immediate. */
export function AdminsPage(): ReactNode {
  const { me, can } = useSession();
  const { withStepUp } = useStepUp();
  const admins = useResource(endpoints.admins);
  const [error, setError] = useState<string>();
  const isSuper = me?.roles.some((r) => r.role === 'super_admin') === true;

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [grantTo, setGrantTo] = useState('');
  const [grantRole, setGrantRole] = useState<AdminRole>('support_agent');
  const [grantHours, setGrantHours] = useState('720');
  const [eligibleFor, setEligibleFor] = useState('');
  const [eligibleRoles, setEligibleRoles] = useState<('super_admin' | 'security_admin')[]>([]);
  const list = admins.data?.admins ?? [];
  const others = list.filter((a) => a.status === 'active');
  const adminOptions = [
    { value: '', label: 'Choose an admin' },
    ...others.map((a) => ({ value: a.id, label: `${a.email}${a.id === me?.id ? ' (you)' : ''}` })),
  ];

  async function disable(adminId: string) {
    setError(undefined);
    try {
      await withStepUp(() => endpoints.disableAdmin(adminId));
      admins.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="stack">
      <h1>Admins</h1>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {admins.error === undefined ? null : <Alert tone="danger">{admins.error}</Alert>}
      {admins.data === undefined ? <Skeleton width="100%" height="4rem" /> : null}
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Admin</th>
            <th scope="col">Roles now</th>
            <th scope="col">May request</th>
            <th scope="col">Keys</th>
            <th scope="col">Status</th>
            <th scope="col">
              <VisuallyHidden>Actions</VisuallyHidden>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((admin) => (
            <tr key={admin.id}>
              <td>
                {admin.displayName}
                <br />
                <span className="muted">{admin.email}</span>
              </td>
              <td>
                {admin.roles.length === 0
                  ? '—'
                  : admin.roles
                      .map((r) => `${roleName(r.role)} (ends ${until(r.expiresAt)})`)
                      .join(', ')}
              </td>
              <td>{admin.eligibleRoles.map(roleName).join(', ') || '—'}</td>
              <td>{admin.keys}</td>
              <td>{admin.status}</td>
              <td>
                {can('adminsDisable') && admin.status === 'active' && admin.id !== me?.id ? (
                  <Button size="sm" variant="danger" onClick={() => void disable(admin.id)}>
                    Disable {admin.email}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isSuper ? (
        <div className="grid">
          <ChangeRequest
            title="Add an admin"
            submitLabel="Request new admin"
            build={() => ({
              kind: 'admin_create',
              email: email.trim(),
              displayName: displayName.trim(),
            })}
            onRequested={() => {
              setEmail('');
              setDisplayName('');
            }}
          >
            <TextField
              label="Work email"
              type="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
            <TextField
              label="Name"
              required
              maxLength={100}
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
              }}
            />
          </ChangeRequest>
          <ChangeRequest
            title="Grant a role"
            submitLabel="Request role"
            build={() =>
              grantTo === ''
                ? 'Choose an admin.'
                : {
                    kind: 'role_grant',
                    adminId: grantTo,
                    role: grantRole,
                    hours: Number(grantHours),
                  }
            }
          >
            <Select label="Admin" value={grantTo} options={adminOptions} onChange={setGrantTo} />
            <Select
              label="Role"
              value={grantRole}
              options={ADMIN_ROLES.map((role) => ({ value: role, label: roleName(role) }))}
              onChange={(role) => {
                setGrantRole(role);
                if (ELEVATED.has(role)) setGrantHours(String(MAX_ELEVATED_HOURS));
              }}
            />
            <TextField
              label="Hours"
              type="number"
              min={1}
              max={ELEVATED.has(grantRole) ? MAX_ELEVATED_HOURS : 2160}
              hint={
                ELEVATED.has(grantRole)
                  ? 'Elevated roles: at most 8 hours.'
                  : 'At most 90 days (2160 hours).'
              }
              required
              value={grantHours}
              onChange={(e) => {
                setGrantHours(e.target.value);
              }}
            />
          </ChangeRequest>
          <ChangeRequest
            title="Elevation eligibility"
            submitLabel="Request eligibility"
            build={() =>
              eligibleFor === ''
                ? 'Choose an admin.'
                : { kind: 'eligibility', adminId: eligibleFor, roles: eligibleRoles }
            }
          >
            <Select
              label="Admin"
              value={eligibleFor}
              options={adminOptions}
              onChange={setEligibleFor}
            />
            <fieldset>
              <legend>May request just in time</legend>
              {(['security_admin', 'super_admin'] as const).map((role) => (
                <label key={role} className="radio">
                  <input
                    type="checkbox"
                    checked={eligibleRoles.includes(role)}
                    onChange={(e) => {
                      setEligibleRoles(
                        e.target.checked
                          ? [...eligibleRoles, role]
                          : eligibleRoles.filter((r) => r !== role),
                      );
                    }}
                  />
                  {roleName(role)}
                </label>
              ))}
            </fieldset>
          </ChangeRequest>
        </div>
      ) : null}
    </section>
  );
}
