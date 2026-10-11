import { defineConfig } from 'vite';

/**
 * The load harness runs under Node. It is bundled because the headless clients reuse the web
 * app's own messaging and encryption code (apps/web/src), which is TypeScript source; npm
 * packages stay external.
 */
export default defineConfig({
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      input: {
        cli: 'src/cli.ts',
        generator: 'src/generator.ts',
        'headless-worker': 'src/headless/worker.ts',
      },
      output: { entryFileNames: '[name].js', format: 'es' },
    },
  },
  ssr: { noExternal: [/^@tessera\/(shared|validation)$/] },
});
