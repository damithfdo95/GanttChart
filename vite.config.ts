/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// ---- build/release metadata (Settings → Release) ----------------------------
// Baked into the bundle as constants so the running app can show exactly which
// release it is without any network request (see src/lib/buildInfo.ts). Outside
// a git checkout (e.g. an exported archive) the git fields degrade to ''.
const git = (args: string): string => {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const BUILD_INFO_DEFINE = {
  __BUILD_VERSION__: JSON.stringify(pkg.version),
  __BUILD_COMMIT__: JSON.stringify(git('rev-parse --short=12 HEAD')),
  __BUILD_RELEASE__: JSON.stringify(git('describe --tags --always --dirty')),
  __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  // Release channel: this baseline is the pilot. Override with RELEASE_CHANNEL when a different channel exists.
  __BUILD_CHANNEL__: JSON.stringify(process.env.RELEASE_CHANNEL ?? 'pilot'),
};

// base './' keeps all asset URLs relative so dist/ can be served from any
// local folder or static server without network access (§3, §6).
//
// Optional: GC_API=http://localhost:8787 npm run dev  → /api and /ws go to the
// local Worker (`wrangler dev --env dev` in worker/), so the shared mode can be
// developed with hot reload. Without it there is no backend and the app runs
// local-only, exactly as before.
export default defineConfig(({ mode }) => {
  const apiTarget = loadEnv(mode, '.', '').GC_API;
  return {
    base: './',
    // Replace the build-info constants at compile time (see BUILD_INFO_DEFINE).
    define: BUILD_INFO_DEFINE,
    plugins: [react()],
    server: apiTarget
      ? {
          proxy: {
            '/api': { target: apiTarget, changeOrigin: false },
            '/ws': { target: apiTarget, ws: true, changeOrigin: false },
          },
        }
      : undefined,
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          // Keep the vendor runtime (React + scheduler) out of the app bundle
          // so the main chunk stays well under the 500 kB warning and the
          // long-lived vendor chunk caches across app-only deploys.
          manualChunks(id) {
            // Keep the vendor runtime (React + scheduler) out of the app bundle
            // so the main chunk stays well under the 500 kB warning and the
            // long-lived vendor chunk caches across app-only deploys.
            if (id.includes('node_modules/react-dom') || id.match(/node_modules[\\/]react[\\/]/) || id.includes('node_modules/scheduler')) {
              return 'vendor';
            }
            // The bilingual locale dictionaries are large but change rarely —
            // isolate them so they cache independently of app logic.
            if (id.includes('src/locales/')) {
              return 'locales';
            }
          },
        },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'proxies/**/*.test.ts'],
      // Vitest blanks CSS by default; the layout guard tests read the real stylesheet text.
      css: { include: [/src[/]index[.]css/] },
    },
  };
});
