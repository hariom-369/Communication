import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/**/*.test.ts', 'src/test/**'] },
  },
});
