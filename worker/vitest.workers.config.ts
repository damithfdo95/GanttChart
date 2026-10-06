import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Integration tests that run INSIDE the real local Workers runtime (workerd):
// the actual Worker, the actual Durable Object, real SQLite, real WebSockets.

// Some negative tests deliberately make a Durable Object REFUSE a call (wrong tenant, not the
// legacy workspace, unbound object). The test asserts the rejection; workerd additionally reports the
// refusal as an "uncaught exception", which Vitest surfaces as an unhandled error and turns into a
// failing exit code. Only these exact, expected refusals are ignored; any other unhandled error still fails.
const EXPECTED_REFUSALS = [/^tenant mismatch$/, /^not the legacy workspace$/, /^workspace is not bound to a tenant$/, /no such table: records/];

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  test: {
    include: ['test/workers/**/*.test.ts'],
    testTimeout: 15_000,
    onUnhandledError(error) {
      const message = String((error as { message?: unknown } | null)?.message ?? error);
      if (EXPECTED_REFUSALS.some((pattern) => pattern.test(message))) return false;
      return undefined;
    },
  },
});
