import { Alert, Button, Skeleton } from '@tessera/ui';
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';

import { HOME_PATH } from './home.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { GrievancePage } from './pages/GrievancePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { MfaPage } from './pages/MfaPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { SetupCredentialPage } from './pages/SetupCredentialPage.js';
import { SignUpPage } from './pages/SignUpPage.js';
import { VerifyEmailPage } from './pages/VerifyEmailPage.js';
import { useSession, type SessionStatus } from './state/session.js';

function Loading(): ReactNode {
  return (
    <div className="boot" role="status" aria-busy="true" aria-label="Loading Tessera">
      <Skeleton width="12rem" height="2rem" shape="tile" />
      <Skeleton width="20rem" height="1rem" />
    </div>
  );
}

/**
 * Signed-in pages are separate chunks, loaded when first visited (docs/performance.md); the
 * service worker pins them with the rest of the release.
 */
function page<M>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType,
): () => Promise<{ Component: ComponentType }> {
  return async () => ({ Component: pick(await load()) });
}

const SignedInLayout = lazy(() =>
  import('./signed-in.js').then((module) => ({ default: module.SignedInLayout })),
);
const SuspendedScreen = lazy(() =>
  import('./pages/settings/AccountStatusPage.js').then((module) => ({
    default: module.SuspendedScreen,
  })),
);

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
  // A suspended or banned account sees only its status (and can appeal or sign out).
  if (status === 'suspended')
    return (
      <Suspense fallback={<Loading />}>
        <SuspendedScreen />
      </Suspense>
    );
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
    <Suspense fallback={<Loading />}>
      <SignedInLayout />
    </Suspense>
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
  { path: '/grievance', element: <GrievancePage /> },
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
    // Shown while a page's chunk loads on the first visit.
    hydrateFallbackElement: <Loading />,
    children: [
      { path: '/settings', element: <Navigate to="/settings/security" replace /> },
      {
        path: '/settings/security',
        lazy: page(
          () => import('./pages/settings/SecurityPage.js'),
          (m) => m.SecurityPage,
        ),
      },
      {
        path: '/settings/devices',
        lazy: page(
          () => import('./pages/settings/DevicesPage.js'),
          (m) => m.DevicesPage,
        ),
      },
      {
        path: '/settings/privacy',
        lazy: page(
          () => import('./pages/settings/PrivacyPage.js'),
          (m) => m.PrivacyPage,
        ),
      },
      {
        path: '/settings/notifications',
        lazy: page(
          () => import('./pages/settings/NotificationsPage.js'),
          (m) => m.NotificationsPage,
        ),
      },
      {
        path: '/settings/account',
        lazy: page(
          () => import('./pages/settings/AccountPage.js'),
          (m) => m.AccountPage,
        ),
      },
      {
        path: '/settings/status',
        lazy: page(
          () => import('./pages/settings/AccountStatusPage.js'),
          (m) => m.AccountStatusPage,
        ),
      },
      {
        path: '/settings/plan',
        lazy: page(
          () => import('./pages/settings/PlanPage.js'),
          (m) => m.PlanPage,
        ),
      },
      {
        path: '/settings/plan/invoices/:invoiceId',
        lazy: page(
          () => import('./pages/settings/InvoicePage.js'),
          (m) => m.InvoicePage,
        ),
      },
      {
        path: '/moderation',
        lazy: page(
          () => import('./pages/moderation/ModerationPage.js'),
          (m) => m.ModerationPage,
        ),
      },
      {
        path: '/moderation/cases/:caseId',
        lazy: page(
          () => import('./pages/moderation/CaseView.js'),
          (m) => m.CaseView,
        ),
      },
      {
        path: '/chats',
        lazy: page(
          () => import('./pages/chats/ChatsPage.js'),
          (m) => m.ChatsPage,
        ),
      },
      {
        path: '/chats/:conversationId',
        lazy: page(
          () => import('./pages/chats/ChatsPage.js'),
          (m) => m.ChatsPage,
        ),
      },
      {
        path: '/invite/:token',
        lazy: page(
          () => import('./pages/InvitePage.js'),
          (m) => m.InvitePage,
        ),
      },
      {
        path: '/channels',
        lazy: page(
          () => import('./pages/channels/ChannelsPage.js'),
          (m) => m.ChannelsPage,
        ),
      },
      {
        path: '/channels/:channelId',
        lazy: page(
          () => import('./pages/channels/ChannelPage.js'),
          (m) => m.ChannelPage,
        ),
      },
      {
        path: '/channel-invite/:token',
        lazy: page(
          () => import('./pages/channels/ChannelInvitePage.js'),
          (m) => m.ChannelInvitePage,
        ),
      },
      {
        path: '/communities',
        lazy: page(
          () => import('./pages/communities/CommunitiesPage.js'),
          (m) => m.CommunitiesPage,
        ),
      },
      {
        path: '/communities/:communityId',
        lazy: page(
          () => import('./pages/communities/CommunityPage.js'),
          (m) => m.CommunityPage,
        ),
      },
      {
        path: '/join/:token',
        lazy: page(
          () => import('./pages/communities/CommunityInvitePage.js'),
          (m) => m.CommunityInvitePage,
        ),
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);

export function App(): ReactNode {
  return <RouterProvider router={router} />;
}
