import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { AuthLayout } from '../components/AuthLayout.js';
import { PageHeading } from '../components/PageHeading.js';

export function NotFoundPage(): ReactNode {
  return (
    <AuthLayout>
      <PageHeading description="The page you are looking for does not exist.">
        Page not found
      </PageHeading>
      <p>
        <Link to="/">Go to Tessera</Link>
      </p>
    </AuthLayout>
  );
}
