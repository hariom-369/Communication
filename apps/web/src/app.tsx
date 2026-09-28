import { Alert, Button, Skeleton } from '@tessera/ui';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';

import { AppShell } from './components/AppShell.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { MfaPage } from './pages/MfaPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { AccountPage } from './pages/settings/AccountPage.js';
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
    return <Navigate to="/settings/security" replace state={{ welcome: pathname === '/setup' }} />;
  }
  if (status === 'setup') return <Navigate to="/setup" replace />;
  return <Navigate to="/login" replace />;
}

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
    path: '/settings',
    element: (
      <Guard allow={['active']}>
        <StepUpProvider>
          <Outlet />
        </StepUpProvider>
      </Guard>
    ),
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/settings/security" replace /> },
          { path: 'security', element: <SecurityPage /> },
          { path: 'privacy', element: <PrivacyPage /> },
          { path: 'account', element: <AccountPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);

export function App(): ReactNode {
  return <RouterProvider router={router} />;
}
