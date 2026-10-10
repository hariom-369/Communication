import { defineConfig, devices } from '@playwright/test';

/**
 * Admin console E2E tests against the production build (vite preview, strict CSP), the real
 * `admin-server` process, PostgreSQL and Valkey, and a test identity provider (see
 * e2e/global-setup.ts). Security keys are Chromium virtual authenticators.
 */
export const ADMIN_URL = 'http://localhost:4174';

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
    baseURL: ADMIN_URL,
    trace: 'retain-on-failure',
    launchOptions: executablePath === undefined ? {} : { executablePath },
  },
  projects: [{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } }],
});
