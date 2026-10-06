/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' keeps all asset URLs relative so dist/ can be served from any
// local folder or static server without network access (§3, §6).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
