/**
 * The pinned app shell (docs/e2ee.md §7, ADR-052, review item S-03). The service worker serves
 * the app from the files of one verified release, kept in Cache Storage:
 *
 *  - a release is installed only if `release.json` verifies (Ed25519, in the crypto core) under a
 *    key this browser already trusts — the keys of the release it runs, or on first install the
 *    keys built into this service worker (trust on first use) — and is not older than the one
 *    running; then every listed file is downloaded and must match its SHA-256;
 *  - if anything fails, installation fails and the browser keeps the previous service worker and
 *    its files;
 *  - page loads and the app's own files are answered from the verified copy (which also makes the
 *    app open offline); everything else (API, realtime, media) goes to the network unchanged.
 *
 * Limit (stated in the docs): the browser fetches the service worker script itself from the
 * network, so a server that serves a malicious `sw.js` is not stopped by this — it defends against
 * tampered or mixed-up asset files and rollbacks, and makes every release auditable.
 */

export interface Release {
  readonly v: 1;
  readonly sequence: number;
  readonly version: string;
  readonly official: boolean;
  /** Keys trusted for the next release (the signing key, plus any announced successor). */
  readonly keys: readonly string[];
  /** Path → base64 SHA-256. */
  readonly files: Readonly<Record<string, string>>;
}

interface State {
  /** The Cache Storage cache holding this release's verified files. */
  readonly cache: string;
  readonly sequence: number;
  readonly version: string;
  readonly keys: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}

export interface ReleaseCore {
  verifyRelease(manifest: Uint8Array, signature: string, keys: string): boolean;
  releaseDigest(file: Uint8Array): string;
}

export interface ShellDeps {
  readonly fetch: (path: string) => Promise<Response>;
  readonly caches: CacheStorage;
  readonly core: () => Promise<ReleaseCore>;
  /** Keys and release number written into this service worker by scripts/release.mjs. */
  readonly embedded: { readonly keys: readonly string[]; readonly sequence: number } | null;
}

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseError';
  }
}

const SHELL_PREFIX = 'tessera-shell-';
const STATE_CACHE = 'tessera-release';
const STATE_KEY = '/__tessera/release-state';
/** Source maps are not executed; they are left to the network. */
const skipped = (path: string): boolean => path.endsWith('.map');
/** Paths that are never the app shell. */
const PASS_THROUGH = /^\/(api|rt|sfu)\//;

function isState(value: unknown): value is State {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state['cache'] === 'string' &&
    typeof state['sequence'] === 'number' &&
    Array.isArray(state['keys']) &&
    typeof state['files'] === 'object' &&
    state['files'] !== null
  );
}

function parseRelease(bytes: Uint8Array): Release {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Release>;
  if (
    value.v !== 1 ||
    typeof value.sequence !== 'number' ||
    !Array.isArray(value.keys) ||
    typeof value.files !== 'object'
  )
    throw new ReleaseError('release manifest is malformed');
  return value as Release;
}

export class ReleaseShell {
  readonly #deps: ShellDeps;
  #state: Promise<State | null> | null = null;
  #pending: State | null = null;

  constructor(deps: ShellDeps) {
    this.#deps = deps;
  }

  /** Whether this build pins at all (development builds are not signed). */
  get enabled(): boolean {
    return this.#deps.embedded !== null;
  }

  async #readState(): Promise<State | null> {
    const cache = await this.#deps.caches.open(STATE_CACHE);
    const stored = await cache.match(STATE_KEY);
    if (stored === undefined) return null;
    try {
      const value: unknown = await stored.json();
      return isState(value) ? value : null;
    } catch {
      return null;
    }
  }

  state(): Promise<State | null> {
    this.#state ??= this.#readState();
    return this.#state;
  }

  /** `install`: verify and download the release this service worker belongs to. */
  async install(): Promise<void> {
    const embedded = this.#deps.embedded;
    if (embedded === null) return;
    const previous = await this.#readState();
    const trusted = previous?.keys ?? embedded.keys;
    const [manifestResponse, signatureResponse] = await Promise.all([
      this.#deps.fetch('/release.json'),
      this.#deps.fetch('/release.json.sig'),
    ]);
    if (!manifestResponse.ok || !signatureResponse.ok)
      throw new ReleaseError('release manifest unavailable');
    const manifest = new Uint8Array(await manifestResponse.arrayBuffer());
    const signature = (await signatureResponse.text()).trim();
    const core = await this.#deps.core();
    if (!core.verifyRelease(manifest, signature, JSON.stringify(trusted)))
      throw new ReleaseError('release signature does not verify under a trusted key');
    const release = parseRelease(manifest);
    if (release.sequence !== embedded.sequence)
      throw new ReleaseError('release manifest does not belong to this service worker');
    if (previous !== null && release.sequence < previous.sequence)
      throw new ReleaseError('refusing an older release');

    // A cache of its own per installation, so a failed one never touches the running copy.
    const name = `${SHELL_PREFIX}${String(release.sequence)}-${crypto.randomUUID()}`;
    const cache = await this.#deps.caches.open(name);
    try {
      for (const [path, digest] of Object.entries(release.files)) {
        if (skipped(path)) continue;
        const response = await this.#deps.fetch(path);
        if (!response.ok) throw new ReleaseError(`release file unavailable: ${path}`);
        const bytes = new Uint8Array(await response.clone().arrayBuffer());
        if (core.releaseDigest(bytes) !== digest)
          throw new ReleaseError(`release file does not match the manifest: ${path}`);
        await cache.put(path, response);
      }
    } catch (error) {
      await this.#deps.caches.delete(name);
      throw error;
    }
    this.#pending = {
      cache: name,
      sequence: release.sequence,
      version: typeof release.version === 'string' ? release.version : '',
      keys: release.keys,
      files: release.files,
    };
  }

  /** `activate`: switch to the verified release and drop older copies. */
  async activate(): Promise<void> {
    const pending = this.#pending;
    if (pending === null) return;
    const store = await this.#deps.caches.open(STATE_CACHE);
    await store.put(
      STATE_KEY,
      new Response(JSON.stringify(pending), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    this.#state = Promise.resolve(pending);
    for (const name of await this.#deps.caches.keys())
      if (name.startsWith(SHELL_PREFIX) && name !== pending.cache)
        await this.#deps.caches.delete(name);
    this.#pending = null;
  }

  /**
   * `fetch`: the verified copy of an app file or of the page itself, or `null` to let the request
   * go to the network (API, realtime, media, anything not in the release).
   */
  async respond(
    request: { url: string; method: string; mode: string },
    origin: string,
  ): Promise<Response | null> {
    if (!this.enabled || request.method !== 'GET') return null;
    const url = new URL(request.url);
    if (url.origin !== origin || PASS_THROUGH.test(url.pathname)) return null;
    const state = await this.state();
    if (state === null) return null;
    const path =
      request.mode === 'navigate'
        ? '/index.html'
        : url.pathname in state.files
          ? url.pathname
          : null;
    if (path === null || skipped(path)) return null;
    const cached = await (await this.#deps.caches.open(state.cache)).match(path);
    return cached ?? null;
  }
}

/** Reads what scripts/release.mjs wrote into the built service worker (null: not a release build). */
export function embeddedRelease(
  keys: string,
  sequence: string | number,
): { keys: readonly string[]; sequence: number } | null {
  if (!keys.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(keys) as unknown;
    const number = Number(sequence);
    if (!Array.isArray(parsed) || parsed.length === 0 || !Number.isSafeInteger(number)) return null;
    return { keys: parsed.filter((k): k is string => typeof k === 'string'), sequence: number };
  } catch {
    return null;
  }
}
