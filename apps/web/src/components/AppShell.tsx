import { Button } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { CallOverlay } from '../pages/calls/CallOverlay.js';
import { useSession } from '../state/session.js';

import { Brand } from './Brand.js';
import { OfflineBanner } from './OfflineBanner.js';

const NAV: readonly { to: string; label: string }[] = [
  { to: '/chats', label: 'Chats' },
  { to: '/communities', label: 'Communities' },
  { to: '/channels', label: 'Channels' },
  { to: '/settings/security', label: 'Security' },
  { to: '/settings/devices', label: 'Devices' },
  { to: '/settings/privacy', label: 'Privacy' },
  { to: '/settings/account', label: 'Account' },
];

/** Signed-in layout. Desktop: navigation rail + content. Mobile: top bar + content. */
export function AppShell(): ReactNode {
  const { me, clear } = useSession();
  const { pathname } = useLocation();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string>();

  async function signOut() {
    setSigningOut(true);
    try {
      await endpoints.logout();
      // The route guard redirects to /login once the session is anonymous (a second, explicit
      // navigation here was redundant).
      clear();
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
      <main
        className={
          pathname.startsWith('/chats')
            ? 'app-shell__main app-shell__main--wide'
            : 'app-shell__main'
        }
        id="main"
      >
        <CallOverlay />
        <Outlet />
      </main>
    </div>
  );
}
