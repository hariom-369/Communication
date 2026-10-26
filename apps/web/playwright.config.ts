import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the production build (vite preview, strict CSP) and a real API
 * process backed by PostgreSQL, Valkey and a local SMTP capture server (see e2e/global-setup.ts).
 * WebAuthn uses Chromium's virtual authenticator.
 */
export const WEB_URL = 'http://localhost:4173';

const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  // In CI: failures also as annotations on the run (readable without the full log), and stop
  // after five, so a broken environment reports its errors instead of reaching the job timeout.
  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['github']],
  maxFailures: process.env['CI'] === undefined ? 0 : 5,
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    // Full Chromium in headless mode, not the separate headless-shell build Playwright uses by
    // default: push notifications and group-call media need the full browser.
    ...(executablePath === undefined ? { channel: 'chromium' } : {}),
    launchOptions: {
      ...(executablePath === undefined ? {} : { executablePath }),
      // Calls: synthetic camera and microphone, permission prompts and the screen picker
      // answered automatically (docs/testing.md).
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
      ],
    },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
});
