import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Integration tests that run INSIDE the real local Workers runtime (workerd):
// the actual Worker, the actual Durable Object, real SQLite, real WebSockets.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  test: {
    include: ['test/workers/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
