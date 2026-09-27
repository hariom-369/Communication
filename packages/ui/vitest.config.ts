import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/**/*.test.*'] },
  },
});
