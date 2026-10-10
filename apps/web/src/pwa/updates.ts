/**
 * Tells the person when an update to the app was refused (sw/release.ts: its manifest or files
 * did not verify). The browser keeps running the last verified release; saying so makes a
 * tampered or broken deployment visible instead of silent (ADR-052).
 */

let refused = false;
const listeners = new Set<() => void>();

export function watchUpdates(registration: ServiceWorkerRegistration): void {
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    // Only updates: a first installation that fails leaves the page as the network served it.
    if (worker === null || navigator.serviceWorker.controller === null) return;
    worker.addEventListener('statechange', () => {
      if (worker.state !== 'redundant' || registration.active === worker) return;
      refused = true;
      for (const listener of listeners) listener();
    });
  });
}

export function updateRefused(): boolean {
  return refused;
}

export function subscribeUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
