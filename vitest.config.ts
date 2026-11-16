import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shop-agent/core': r('./packages/core/src/index.ts'),
      '@shop-agent/db': r('./packages/db/src/index.ts'),
      '@shop-agent/sdk': r('./packages/sdk/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
