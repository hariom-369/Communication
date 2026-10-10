// Must stay first: configures Zod before any schema module is evaluated.
import './zod-config.js';
import '@tessera/ui/tokens.css';
import '@tessera/ui/components.css';
import './admin.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.js';
import { SessionProvider } from './session.js';
import { StepUpProvider } from './step-up.js';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <SessionProvider>
      <StepUpProvider>
        <App />
      </StepUpProvider>
    </SessionProvider>
  </StrictMode>,
);
