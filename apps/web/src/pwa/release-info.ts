/**
 * Which verified release this browser runs (written by the service worker, sw/release.ts), so a
 * person — or anyone auditing — can compare it with the published release list.
 */

export interface RunningRelease {
  readonly sequence: number;
  readonly version: string;
}

export async function runningRelease(): Promise<RunningRelease | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const stored = await (await caches.open('tessera-release')).match('/__tessera/release-state');
    if (stored === undefined) return null;
    const state = (await stored.json()) as { sequence?: unknown; version?: unknown };
    return typeof state.sequence === 'number'
      ? {
          sequence: state.sequence,
          version: typeof state.version === 'string' ? state.version : '',
        }
      : null;
  } catch {
    return null;
  }
}
