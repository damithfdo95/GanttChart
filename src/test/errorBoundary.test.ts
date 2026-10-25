import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RenderFailure, ScreenErrorBoundary, classifyRenderFailure } from '../components/ErrorBoundary';
import { dictionaries } from '../i18n/dictionaries';

const root = resolve(__dirname, '..');

describe('a failing screen does not blank the app', () => {
  it('classifies a failed lazy import (a new release was deployed) separately from a bug in the screen', () => {
    expect(classifyRenderFailure(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Gantt-1.js'))).toBe('update');
    expect(classifyRenderFailure(new Error('Importing a module script failed.'))).toBe('update');
    expect(classifyRenderFailure(Object.assign(new Error('Loading chunk 3 failed'), { name: 'ChunkLoadError' }))).toBe('update');
    expect(classifyRenderFailure(new Error('Cannot read properties of undefined'))).toBe('render');
    expect(classifyRenderFailure('weird')).toBe('render');
  });

  it('turns a render error into recovery state (derived state) and the recovery screen is calm: alert role, actions, short code, no stack', () => {
    expect(ScreenErrorBoundary.getDerivedStateFromError(new Error('boom\n at secret (file.ts:1)'))).toMatchObject({ failure: 'render' });
    for (const lang of ['en', 'ja'] as const) {
      for (const kind of ['render', 'update'] as const) {
        const html = renderToStaticMarkup(createElement(RenderFailure, { lang, kind, at: '2026-10-25T00:00:00.000Z', onRetry: () => {}, onHome: () => {} }));
        expect(html).toContain('role="alert"');
        expect(html.match(/<button/g)).toHaveLength(2);
        expect(html).toContain(kind === 'update' ? 'APP_UPDATED' : 'SCREEN_RENDER_FAILED');
        expect(html).not.toMatch(/boom|secret|file\.ts|stack/i);
      }
    }
  });

  it('the app wraps the screen area with a boundary that resets on navigation, and logs instead of swallowing', () => {
    const app = readFileSync(join(root, 'app/App.tsx'), 'utf8');
    expect(app).toContain('<ScreenErrorBoundary key={activeScreen}');
    expect(readFileSync(join(root, 'components/ErrorBoundary.tsx'), 'utf8')).toContain("console.error('screen render failed'");
  });

  it('has English and Japanese strings', () => {
    for (const key of ['error.render.title', 'error.render.body', 'error.update.title', 'error.update.body', 'error.retry', 'error.reload', 'error.home', 'error.code']) {
      expect((dictionaries.en as Record<string, string>)[key], key).toBeTruthy();
      expect((dictionaries.ja as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});
