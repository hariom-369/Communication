/**
 * "Install Tessera": the browser's own install prompt, offered from Settings → Account only when
 * the browser says the app can be installed (Chromium-based browsers fire `beforeinstallprompt`;
 * others install from their own menu, which the page then says). Imported by main.tsx so the
 * event is not missed before the page renders.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState = 'installed' | 'available' | 'unavailable';

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

function standalone(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // offered from Settings, not as a browser banner
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    notify();
  });
}

export function installState(): InstallState {
  if (installed || standalone()) return 'installed';
  return deferred === null ? 'unavailable' : 'available';
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shows the browser's install dialog; resolves to whether the person installed. */
export async function install(): Promise<boolean> {
  const event = deferred;
  if (event === null) return false;
  deferred = null; // a prompt can be shown once
  await event.prompt();
  const choice = await event.userChoice;
  notify();
  return choice.outcome === 'accepted';
}
