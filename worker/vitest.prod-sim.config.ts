import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The Worker configured like PRODUCTION (real Access JWT verification, public static
// shell, no development identity) inside local workerd. See wrangler.prod-sim.jsonc.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.prod-sim.jsonc' } })],
  test: {
    include: ['test/prod-sim/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
