import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // node:sqlite prints an ExperimentalWarning on some Node versions; keep test output clean.
    env: { NODE_NO_WARNINGS: '1' },
  },
});
