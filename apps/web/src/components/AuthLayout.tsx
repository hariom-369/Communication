import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { Brand } from './Brand.js';
import { OfflineBanner } from './OfflineBanner.js';
import { UpdateBanner } from './UpdateBanner.js';

/** Layout for signed-out flows: brand, a focused card, and the privacy promise. */
export function AuthLayout({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  return (
    <div className="auth-layout">
      <OfflineBanner />
      <UpdateBanner />
      <main className="auth-layout__main" id="main" tabIndex={-1}>
        <Link to="/" className="auth-layout__brand" aria-label="Tessera home">
          <Brand />
        </Link>
        <section className="auth-card">{children}</section>
        {footer === undefined ? null : <div className="auth-layout__footer">{footer}</div>}
      </main>
      <footer className="auth-layout__promise">
        <p>
          Private chats on Tessera are end-to-end encrypted. We never ask for your password by
          email.
        </p>
      </footer>
    </div>
  );
}
