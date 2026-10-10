import { useSyncExternalStore, type ReactNode } from 'react';

import { subscribeUpdates, updateRefused } from '../pwa/updates.js';

/** Shown when an update did not verify and was not installed (pwa/updates.ts). */
export function UpdateBanner(): ReactNode {
  const refused = useSyncExternalStore(subscribeUpdates, updateRefused, () => false);
  if (!refused) return null;
  return (
    <div className="offline-banner" role="status">
      An update to Tessera could not be verified, so it was not installed. You are still using the
      last verified version. If this message keeps appearing, tell us — the update may have been
      tampered with.
    </div>
  );
}
