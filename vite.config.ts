/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

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
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});
