import { Alert, Button, Skeleton } from '@tessera/ui';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';

import { Shell } from './components/Shell.js';
import { AdminsPage } from './pages/AdminsPage.js';
import { ApprovalsPage } from './pages/ApprovalsPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { CallbackPage } from './pages/CallbackPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { FlagsPage } from './pages/FlagsPage.js';
import { HealthPage } from './pages/HealthPage.js';
import { KeyStepPage } from './pages/KeyStepPage.js';
import { PeoplePage } from './pages/PeoplePage.js';
import { PersonPage } from './pages/PersonPage.js';
import { SecurityPage } from './pages/SecurityPage.js';
import { SignInPage } from './pages/SignInPage.js';
import { StaffPage } from './pages/StaffPage.js';
import { TicketsPage } from './pages/TicketsPage.js';
import { useSession } from './session.js';

function Loading(): ReactNode {
  return (
    <div className="boot" role="status" aria-busy="true" aria-label="Loading the admin console">
      <Skeleton width="12rem" height="2rem" shape="tile" />
    </div>
  );
}

/** Signed-in pages: anything else goes to the step that is missing. */
function SignedIn({ children }: { children: ReactNode }): ReactNode {
  const { status, refresh } = useSession();
  if (status === 'loading') return <Loading />;
  if (status === 'signed_out') return <Navigate to="/sign-in" replace />;
  if (status === 'key') return <Navigate to="/key" replace />;
  if (status === 'offline')
    return (
      <div className="boot">
        <Alert tone="warning" title="Cannot reach the admin API">
          <p>Check your connection and the access proxy.</p>
          <Button size="sm" onClick={() => void refresh()}>
            Try again
          </Button>
        </Alert>
      </div>
    );
  return <Shell>{children}</Shell>;
}

const router = createBrowserRouter([
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/auth/callback', element: <CallbackPage /> },
  { path: '/key', element: <KeyStepPage /> },
  {
    path: '/',
    element: (
      <SignedIn>
        <DashboardPage />
      </SignedIn>
    ),
  },
  {
    path: '/people',
    element: (
      <SignedIn>
        <PeoplePage />
      </SignedIn>
    ),
  },
  {
    path: '/people/:userId',
    element: (
      <SignedIn>
        <PersonPage />
      </SignedIn>
    ),
  },
  {
    path: '/tickets',
    element: (
      <SignedIn>
        <TicketsPage />
      </SignedIn>
    ),
  },
  {
    path: '/approvals',
    element: (
      <SignedIn>
        <ApprovalsPage />
      </SignedIn>
    ),
  },
  {
    path: '/admins',
    element: (
      <SignedIn>
        <AdminsPage />
      </SignedIn>
    ),
  },
  {
    path: '/staff',
    element: (
      <SignedIn>
        <StaffPage />
      </SignedIn>
    ),
  },
  {
    path: '/flags',
    element: (
      <SignedIn>
        <FlagsPage />
      </SignedIn>
    ),
  },
  {
    path: '/audit',
    element: (
      <SignedIn>
        <AuditPage />
      </SignedIn>
    ),
  },
  {
    path: '/health',
    element: (
      <SignedIn>
        <HealthPage />
      </SignedIn>
    ),
  },
  {
    path: '/security',
    element: (
      <SignedIn>
        <SecurityPage />
      </SignedIn>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

export function App(): ReactNode {
  return <RouterProvider router={router} />;
}
