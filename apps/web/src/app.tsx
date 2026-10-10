import { Alert, Button, Skeleton } from '@tessera/ui';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';

import { AppShell } from './components/AppShell.js';
import { HOME_PATH } from './home.js';
import { MessagingProvider } from './messaging/provider.js';
import { ChatsPage } from './pages/chats/ChatsPage.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { ChannelInvitePage } from './pages/channels/ChannelInvitePage.js';
import { ChannelPage } from './pages/channels/ChannelPage.js';
import { ChannelsPage } from './pages/channels/ChannelsPage.js';
import { CommunitiesPage } from './pages/communities/CommunitiesPage.js';
import { CommunityInvitePage } from './pages/communities/CommunityInvitePage.js';
import { CommunityPage } from './pages/communities/CommunityPage.js';
import { InvitePage } from './pages/InvitePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { MfaPage } from './pages/MfaPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { AccountPage } from './pages/settings/AccountPage.js';
import { DevicesPage } from './pages/settings/DevicesPage.js';
import { NotificationsPage } from './pages/settings/NotificationsPage.js';
import { PrivacyPage } from './pages/settings/PrivacyPage.js';
import { SecurityPage } from './pages/settings/SecurityPage.js';
import { SetupCredentialPage } from './pages/SetupCredentialPage.js';
import { SignUpPage } from './pages/SignUpPage.js';
import { VerifyEmailPage } from './pages/VerifyEmailPage.js';
import { useSession, type SessionStatus } from './state/session.js';
import { StepUpProvider } from './state/step-up.js';

function Loading(): ReactNode {
  return (
    <div className="boot" role="status" aria-busy="true" aria-label="Loading Tessera">
      <Skeleton width="12rem" height="2rem" shape="tile" />
      <Skeleton width="20rem" height="1rem" />
    </div>
  );
}

function Offline(): ReactNode {
  const { refresh } = useSession();
  return (
    <div className="boot">
      <Alert tone="warning" title="Cannot reach Tessera">
        <p>Check your connection. We will keep your place.</p>
        <Button size="sm" onClick={() => void refresh()}>
          Try again
        </Button>
      </Alert>
    </div>
  );
}

/** Route guard: renders children only in the allowed session states, redirecting otherwise. */
function Guard({
  allow,
  children,
}: {
  allow: readonly SessionStatus[];
  children: ReactNode;
}): ReactNode {
  const { status } = useSession();
  const { pathname } = useLocation();
  if (status === 'loading') return <Loading />;
  if (status === 'offline') return <Offline />;
  if (allow.includes(status)) return children;
  // Finishing credential setup lands on Security with a welcome message.
  if (status === 'active') {
    return pathname === '/setup' ? (
      <Navigate to="/settings/security" replace state={{ welcome: true }} />
    ) : (
      <Navigate to={HOME_PATH} replace />
    );
  }
  if (status === 'setup') return <Navigate to="/setup" replace />;
  return <Navigate to="/login" replace />;
}

const signedInArea = (
  <Guard allow={['active']}>
    <StepUpProvider>
      <MessagingProvider>
        <AppShell />
      </MessagingProvider>
    </StepUpProvider>
  </Guard>
);

const router = createBrowserRouter([
  { path: '/', element: <Guard allow={[]}>{null}</Guard> },
  {
    path: '/login',
    element: (
      <Guard allow={['anonymous']}>
        <LoginPage />
      </Guard>
    ),
  },
  // The MFA step has a half-authenticated session that /accounts/me does not accept.
  {
    path: '/login/verify',
    element: (
      <Guard allow={['anonymous']}>
        <MfaPage />
      </Guard>
    ),
  },
  {
    path: '/signup',
    element: (
      <Guard allow={['anonymous']}>
        <SignUpPage />
      </Guard>
    ),
  },
  {
    path: '/verify-email',
    element: (
      <Guard allow={['anonymous']}>
        <VerifyEmailPage />
      </Guard>
    ),
  },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    path: '/setup',
    element: (
      <Guard allow={['setup']}>
        <SetupCredentialPage />
      </Guard>
    ),
  },
  {
    element: signedInArea,
    children: [
      { path: '/settings', element: <Navigate to="/settings/security" replace /> },
      { path: '/settings/security', element: <SecurityPage /> },
      { path: '/settings/devices', element: <DevicesPage /> },
      { path: '/settings/privacy', element: <PrivacyPage /> },
      { path: '/settings/notifications', element: <NotificationsPage /> },
      { path: '/settings/account', element: <AccountPage /> },
      { path: '/chats', element: <ChatsPage /> },
      { path: '/chats/:conversationId', element: <ChatsPage /> },
      { path: '/invite/:token', element: <InvitePage /> },
      { path: '/channels', element: <ChannelsPage /> },
      { path: '/channels/:channelId', element: <ChannelPage /> },
      { path: '/channel-invite/:token', element: <ChannelInvitePage /> },
      { path: '/communities', element: <CommunitiesPage /> },
      { path: '/communities/:communityId', element: <CommunityPage /> },
      { path: '/join/:token', element: <CommunityInvitePage /> },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);

export function App(): ReactNode {
  return <RouterProvider router={router} />;
}
