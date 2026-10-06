import { defineConfig } from 'vitest/config';

// Pure-logic tests (store, protocol, auth): plain Node, real SQLite via sql.js.
// Workers-runtime integration tests live in vitest.workers.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/workers/**', 'test/prod-sim/**'],
  },
});
