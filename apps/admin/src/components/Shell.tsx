import { Button } from '@tessera/ui';
import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';

import { endpoints } from '../endpoints.js';
import { roleName, until } from '../format.js';
import { useSession } from '../session.js';

import { ElevationButton } from './ElevationButton.js';

/** Navigation shows only what the current roles allow (the API enforces it regardless). */
const NAV: readonly { to: string; label: string; capability: string }[] = [
  { to: '/', label: 'Dashboard', capability: 'dashboard' },
  { to: '/people', label: 'People', capability: 'usersView' },
  { to: '/tickets', label: 'Tickets', capability: 'tickets' },
  { to: '/approvals', label: 'Approvals', capability: 'approvalsRequest' },
  { to: '/admins', label: 'Admins', capability: 'adminsView' },
  { to: '/staff', label: 'Staff roles', capability: 'staffView' },
  { to: '/flags', label: 'Feature flags', capability: 'flagsView' },
  { to: '/security', label: 'Security', capability: 'securityEvents' },
  { to: '/health', label: 'Health', capability: 'health' },
  { to: '/audit', label: 'Audit log', capability: 'auditView' },
];

export function Shell({ children }: { children: ReactNode }): ReactNode {
  const { me, can, refresh } = useSession();
  const navigate = useNavigate();

  async function signOut() {
    await endpoints.logout().catch(() => undefined);
    await refresh();
    void navigate('/sign-in', { replace: true });
  }

  return (
    <div className="shell">
      <header className="shell__header">
        <p className="shell__brand">Tessera admin</p>
        <div className="shell__who">
          <span>{me?.email}</span>
          <ul className="roles" aria-label="Your roles">
            {me?.roles.length === 0 ? <li className="role role--none">No roles</li> : null}
            {me?.roles.map((role) => (
              <li key={role.role} className="role">
                {roleName(role.role)} <span className="muted">· ends {until(role.expiresAt)}</span>
              </li>
            ))}
          </ul>
          <ElevationButton />
          <Button size="sm" variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>
      <nav className="shell__nav" aria-label="Admin">
        <ul>
          {NAV.filter((item) => can(item.capability)).map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.to === '/'}>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="shell__main" id="main">
        {children}
      </main>
    </div>
  );
}
