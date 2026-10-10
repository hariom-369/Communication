import { Button } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { useMessaging, useMessagingStore } from '../messaging/provider.js';
import { useStaffRoles } from '../moderation/use-staff.js';
import { useSecurityAlerts } from '../notifications/use-alerts.js';
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
  { to: '/settings/notifications', label: 'Notifications' },
  { to: '/settings/account', label: 'Account' },
  { to: '/settings/plan', label: 'Plan' },
  { to: '/settings/status', label: 'Account status' },
];

/**
 * Encrypted chats can be used by one tab or window of this browser at a time (ADR-048): two
 * would corrupt this device's encryption state.
 */
function OpenElsewhere(): ReactNode {
  const store = useMessagingStore();
  const [busy, setBusy] = useState(false);
  return (
    <section className="encryption-setup" aria-labelledby="elsewhere-heading">
      <h1 id="elsewhere-heading">Tessera is open in another tab</h1>
      <p>
        Your encrypted chats can be open in one tab or window of this browser at a time. Use them
        here instead, and the other tab stops.
      </p>
      <div>
        <Button
          loading={busy}
          loadingLabel="Switching"
          onClick={() => {
            setBusy(true);
            void store?.useHere().finally(() => setBusy(false));
          }}
        >
          Use here
        </Button>
      </div>
    </section>
  );
}

/** Signed-in layout. Desktop: navigation rail + content. Mobile: top bar + content. */
export function AppShell(): ReactNode {
  const { me, clear } = useSession();
  const { pathname } = useLocation();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string>();
  const { device } = useMessaging();
  const { unread } = useSecurityAlerts();
  const staffRoles = useStaffRoles();
  // The console is offered to staff only (the server enforces every staff action anyway).
  const nav =
    staffRoles !== null && staffRoles.length > 0
      ? [...NAV, { to: '/moderation', label: 'Moderation' }]
      : NAV;

  async function signOut() {
    setSigningOut(true);
    try {
      // This session's pushes stop now (they would stop with the session anyway).
      await endpoints.unsubscribePush().catch(() => undefined);
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
          {nav.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) => (isActive ? 'nav-link nav-link--active' : 'nav-link')}
              >
                {item.label}
                {item.to === '/settings/security' && unread > 0 ? (
                  <span className="badge" aria-label={`${unread} new security alerts`}>
                    {unread}
                  </span>
                ) : null}
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
        {device === 'elsewhere' ? (
          <OpenElsewhere />
        ) : (
          <>
            <CallOverlay />
            <Outlet />
          </>
        )}
      </main>
    </div>
  );
}
