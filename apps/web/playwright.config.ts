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
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
});
