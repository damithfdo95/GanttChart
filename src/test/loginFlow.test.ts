import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ACCESS_LOGIN_PATH, ACCESS_PROTECTED_PATHS, PASSWORD_LOGIN_PATH } from '../../shared/routes';
import { LoginForm } from '../features/tenancy/LoginForm';
import loginSource from '../features/tenancy/LoginForm.tsx?raw';
import startupSource from '../app/Startup.tsx?raw';
import authRouteSource from '../../worker/src/routes/auth.ts?raw';

describe('dual login transport', () => {
  it('uses a fixed same-origin top-level link for interactive Access SSO, never fetch', () => {
    const html = renderToStaticMarkup(createElement(LoginForm, { lang: 'en' }));
    expect(ACCESS_LOGIN_PATH).toBe('/login');
    expect(ACCESS_LOGIN_PATH).toMatch(/^\/(?!\/)/);
    expect(html).toContain(`href="${ACCESS_LOGIN_PATH}"`);
    expect(loginSource).not.toMatch(/fetch\(ACCESS_LOGIN_PATH|fetch\(['"]\/login/);
    expect(ACCESS_PROTECTED_PATHS).toContain(ACCESS_LOGIN_PATH);
  });

  it('posts password credentials only to the public same-origin password entry', () => {
    expect(PASSWORD_LOGIN_PATH).toBe('/signin');
    expect(PASSWORD_LOGIN_PATH).toMatch(/^\/(?!\/)/);
    expect(ACCESS_PROTECTED_PATHS).not.toContain(PASSWORD_LOGIN_PATH);
    expect(loginSource).toContain('fetch(PASSWORD_LOGIN_PATH');
    expect(loginSource).not.toContain("fetch('/api/auth/login'");
    expect(authRouteSource).toContain("path === PASSWORD_LOGIN_PATH && method === 'POST'");
  });

  it('performs fresh identity detection after Access returns to the application', () => {
    expect(startupSource).toContain('const detection = await detectServer()');
    expect(startupSource).toMatch(/useEffect\(\(\) => \{[\s\S]*void detect\(\)/);
  });

  it('exposes no caller-controlled or external login destination', () => {
    for (const path of [ACCESS_LOGIN_PATH, PASSWORD_LOGIN_PATH]) {
      expect(path).not.toMatch(/[?#:]|\/\//);
    }
  });
});
