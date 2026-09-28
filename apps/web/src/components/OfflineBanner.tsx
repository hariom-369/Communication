import { useSyncExternalStore, type ReactNode } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Announces loss of connectivity; actions fail with a clear message while offline. */
export function OfflineBanner(): ReactNode {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      You are offline. Changes will not be saved until your connection returns.
    </div>
  );
}
