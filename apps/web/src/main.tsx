// Must stay first: configures Zod before any schema module is evaluated.
import './zod-config.js';
import '@tessera/ui/tokens.css';
import '@tessera/ui/components.css';
import './styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.js';
import { registerServiceWorker } from './lib/worker-policy.js';
import './pwa/install.js';
import { watchUpdates } from './pwa/updates.js';
import { SessionProvider } from './state/session.js';

// The signed, pinned app shell (sw/release.ts): production builds only.
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  void registerServiceWorker()
    .then(watchUpdates)
    .catch(() => undefined);

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
