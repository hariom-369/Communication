import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { chromium, expect, test, type Page } from '@playwright/test';

/**
 * The signed, pinned app shell (docs/e2ee.md §7, ADR-052): the service worker installs only a
 * release whose manifest verifies and whose files match it, serves the app from that copy (also
 * offline), and refuses an update signed by a key it does not trust. Files on the server are
 * changed in place during these tests and always restored.
 */

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const WEB_URL = 'http://localhost:4173';
const run = promisify(execFile);

async function pinned(page: Page): Promise<number> {
  await page.goto('/login');
  await page.getByRole('heading', { level: 1 }).waitFor();
  return page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 100 && navigator.serviceWorker.controller === null; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const names = await caches.keys();
    const shell = names.find((name) => name.startsWith('tessera-shell-'));
    return shell === undefined ? 0 : Number(shell.split('-')[2]);
  });
}

test.describe('signed app shell', () => {
  test('installs the verified release and opens offline', async ({ page, context }) => {
    const sequence = await pinned(page);
    const release = JSON.parse(await readFile(path.join(DIST, 'release.json'), 'utf8')) as {
      sequence: number;
    };
    expect(sequence).toBe(release.sequence);

    // The page and its files now come from the verified copy.
    const reload = await page.reload();
    expect(reload?.fromServiceWorker()).toBe(true);
    expect(reload?.headers()['content-security-policy']).toContain("script-src 'self'");

    await context.setOffline(true);
    await page.reload();
    // The app itself loads; it says it cannot reach the server (no browser error page).
    await expect(page.getByRole('alert')).toContainText('Cannot reach Tessera');
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('a file changed on the server is not used, and a monitor notices it', async ({ page }) => {
    await pinned(page);
    const index = await readFile(path.join(DIST, 'index.html'), 'utf8');
    const entry = /src="(\/assets\/index-[^"]+\.js)"/.exec(index)?.[1] ?? '';
    const file = path.join(DIST, entry);
    const original = await readFile(file);
    const verify = () =>
      run('node', [path.join(DIST, '../scripts/verify-release.mjs'), WEB_URL]).then(
        () => 0,
        (error: unknown) => (error as { code?: number }).code ?? 1,
      );
    expect(await verify()).toBe(0);
    try {
      await writeFile(
        file,
        Buffer.concat([original, Buffer.from('\nwindow.__tampered = true;\n')]),
      );
      await page.reload();
      await page.getByRole('heading', { level: 1 }).waitFor();
      expect(
        await page.evaluate(() => (window as { __tampered?: boolean }).__tampered),
      ).toBeUndefined();
      // Anyone checking the deployment against the signed manifest sees the change.
      expect(await verify()).toBe(1);
    } finally {
      await writeFile(file, original);
    }
  });

  test('a release whose files do not match its manifest is not installed', async ({ page }) => {
    // A file loaded later (not the entry, which the page itself checks with SRI).
    const manifest = JSON.parse(await readFile(path.join(DIST, 'release.json'), 'utf8')) as {
      files: Record<string, string>;
    };
    const lazy = Object.keys(manifest.files).find((p) => /^\/assets\/group-call-.+\.js$/.test(p));
    expect(lazy).toBeDefined();
    const file = path.join(DIST, lazy!);
    const original = await readFile(file);
    try {
      await writeFile(file, Buffer.concat([original, Buffer.from('\n;\n')]));
      await page.goto('/login');
      await page.getByRole('heading', { level: 1 }).waitFor();
      const outcome = await page.evaluate(async () => {
        // The first worker this page registers, followed until installation ends either way.
        let worker: ServiceWorker | null = null;
        for (let i = 0; i < 100 && worker === null; i += 1) {
          const registration = await navigator.serviceWorker.getRegistration('/');
          worker =
            registration?.installing ?? registration?.waiting ?? registration?.active ?? null;
          if (worker === null) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (worker === null) return { state: 'never registered', shells: [], controlled: false };
        const found = worker;
        const state = await new Promise<string>((resolve) => {
          const done = () => found.state === 'redundant' || found.state === 'activated';
          if (done()) resolve(found.state);
          found.addEventListener('statechange', () => {
            if (done()) resolve(found.state);
          });
        });
        return {
          state,
          shells: (await caches.keys()).filter((name) => name.startsWith('tessera-shell-')),
          controlled: navigator.serviceWorker.controller !== null,
        };
      });
      expect(outcome).toEqual({ state: 'redundant', shells: [], controlled: false });
    } finally {
      await writeFile(file, original);
    }
  });

  test('an update signed by an unknown key is refused; the trusted release keeps running', async ({
    page,
  }) => {
    const sequence = await pinned(page);
    const swPath = path.join(DIST, 'sw.js');
    const manifestPath = path.join(DIST, 'release.json');
    const signaturePath = path.join(DIST, 'release.json.sig');
    const originals = await Promise.all(
      [swPath, manifestPath, signaturePath].map((p) => readFile(p)),
    );
    try {
      // A complete, self-consistent "release" — but signed by an attacker's key.
      const attacker = generateKeyPairSync('ed25519');
      const attackerKey = attacker.publicKey
        .export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64');
      const next = sequence + 1;
      const trusted = JSON.parse(originals[1]!.toString()) as { keys: string[] };
      const sw = originals[0]!
        .toString()
        .replace(
          JSON.stringify(JSON.stringify(trusted.keys)),
          JSON.stringify(JSON.stringify([attackerKey])),
        )
        .replace(String(sequence), String(next));
      const manifest = JSON.parse(originals[1]!.toString()) as {
        sequence: number;
        keys: string[];
        files: Record<string, string>;
      };
      manifest.sequence = next;
      manifest.keys = [attackerKey];
      const bytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(swPath, sw);
      await writeFile(manifestPath, bytes);
      await writeFile(
        signaturePath,
        sign(
          null,
          Buffer.concat([Buffer.from('tessera web release manifest v1\n'), bytes]),
          attacker.privateKey,
        ).toString('base64'),
      );
      const outcome = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        if (registration === undefined) return 'no registration';
        await registration.update().catch(() => undefined);
        const installing = registration.installing ?? registration.waiting;
        if (installing === null) return 'no update';
        return new Promise<string>((resolve) => {
          installing.addEventListener('statechange', () => {
            if (installing.state === 'redundant' || installing.state === 'activated')
              resolve(installing.state);
          });
          if (installing.state === 'redundant') resolve('redundant');
        });
      });
      expect(outcome).toBe('redundant');
      // The person is told; the app keeps running the verified release.
      await expect(
        page.getByRole('status').filter({ hasText: 'could not be verified' }),
      ).toBeVisible();
      const active = await page.evaluate(async () => {
        const names = await caches.keys();
        return names.filter((name) => name.startsWith('tessera-shell-'));
      });
      expect(active).toHaveLength(1);
      expect(active[0]).toMatch(new RegExp(`^tessera-shell-${String(sequence)}-`));
    } finally {
      await Promise.all(
        [swPath, manifestPath, signaturePath].map((p, i) => writeFile(p, originals[i]!)),
      );
    }
  });
});

test.describe('installable app', () => {
  test('the manifest is valid and the browser can install the app', async () => {
    // A normal browser profile: Chromium never offers installation in private windows, which
    // is what the other tests' contexts are.
    const profile = await mkdtemp(path.join(tmpdir(), 'tessera-profile-'));
    const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
    const context = await chromium.launchPersistentContext(profile, {
      ...(executablePath === undefined ? {} : { executablePath }),
      baseURL: WEB_URL,
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await pinned(page);
      const cdp = await context.newCDPSession(page);
      const manifest = (await cdp.send('Page.getAppManifest')) as {
        url: string;
        errors: { message: string }[];
      };
      expect(manifest.url).toBe(`${WEB_URL}/manifest.webmanifest`);
      expect(manifest.errors).toEqual([]);
      const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
        installabilityErrors: { errorId: string }[];
      };
      expect(installabilityErrors).toEqual([]);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
    // Every icon the manifest names is part of the signed release, so it is pinned too.
    const release = JSON.parse(await readFile(path.join(DIST, 'release.json'), 'utf8')) as {
      files: Record<string, string>;
    };
    const declared = JSON.parse(
      await readFile(path.join(DIST, 'manifest.webmanifest'), 'utf8'),
    ) as { icons: { src: string }[] };
    for (const icon of declared.icons) expect(release.files).toHaveProperty([icon.src]);
  });
});
