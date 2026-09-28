import { Button } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';

import { errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { useSession } from '../state/session.js';

import { Brand } from './Brand.js';
import { OfflineBanner } from './OfflineBanner.js';

const NAV = [
  { to: '/settings/security', label: 'Security' },
  { to: '/settings/privacy', label: 'Privacy' },
  { to: '/settings/account', label: 'Account' },
] as const;

/**
 * Signed-in layout. Desktop: navigation rail + content. Mobile: top bar + content.
 * Only sections that exist are listed — conversations arrive in Phase 3.
 */
export function AppShell(): ReactNode {
  const { me, clear } = useSession();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string>();

  async function signOut() {
    setSigningOut(true);
    try {
      await endpoints.logout();
      clear();
      await navigate('/login', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
      setSigningOut(false);
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <OfflineBanner />
      <nav className="app-shell__rail" aria-label="Main">
        <Brand />
        <ul className="app-shell__nav">
          {NAV.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) => (isActive ? 'nav-link nav-link--active' : 'nav-link')}
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="app-shell__account">
          <span className="app-shell__username" title={me?.email}>
            @{me?.username}
          </span>
          <Button
            variant="ghost"
            size="sm"
            loading={signingOut}
            loadingLabel="Signing out"
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
          {error === undefined ? null : (
            <p role="alert" className="app-shell__error">
              {error}
            </p>
          )}
        </div>
      </nav>
      <main className="app-shell__main" id="main">
        <Outlet />
      </main>
    </div>
  );
}
