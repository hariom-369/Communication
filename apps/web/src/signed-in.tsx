import type { ReactNode } from 'react';

import { AppShell } from './components/AppShell.js';
import { MessagingProvider } from './messaging/provider.js';
import { StepUpProvider } from './state/step-up.js';

/**
 * The signed-in app's frame (navigation, messaging, encryption engine). Loaded on demand by
 * app.tsx so the sign-in and sign-up pages do not download it (docs/performance.md).
 */
export function SignedInLayout(): ReactNode {
  return (
    <StepUpProvider>
      <MessagingProvider>
        <AppShell />
      </MessagingProvider>
    </StepUpProvider>
  );
}
