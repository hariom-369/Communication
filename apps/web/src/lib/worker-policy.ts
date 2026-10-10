interface TrustedTypePolicyFactory {
  createPolicy(
    name: string,
    rules: { createScriptURL: (input: string) => string },
    // Returns a TrustedScriptURL; typed as string because that is what `new Worker` is declared
    // to accept, and it stringifies to the checked URL.
  ): { createScriptURL(input: string): string };
}

/**
 * The app enforces Trusted Types (docs/security.md §3). This is the only policy: it produces
 * script URLs for our workers (crypto, call media), and only for scripts on our own origin.
 */
const workerPolicy = (
  globalThis as { trustedTypes?: TrustedTypePolicyFactory }
).trustedTypes?.createPolicy('tessera-worker', {
  createScriptURL: (input) => {
    const url = new URL(input, window.location.href);
    if (url.origin !== window.location.origin) throw new TypeError('Cross-origin worker refused');
    return url.href;
  },
});

/** Starts a same-origin module worker under the Trusted Types policy. */
export function startWorker(url: string, name: string): Worker {
  return new Worker(workerPolicy?.createScriptURL(url) ?? url, { type: 'module', name });
}

/** The service worker (push notifications); a classic script at a fixed URL on our origin. */
export const SERVICE_WORKER_URL = '/sw.js';

/** Registers the service worker under the same Trusted Types policy. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const url = workerPolicy?.createScriptURL(SERVICE_WORKER_URL) ?? SERVICE_WORKER_URL;
  // Always revalidate the script itself, so a security fix reaches every browser quickly.
  return navigator.serviceWorker.register(url, { scope: '/', updateViaCache: 'none' });
}
