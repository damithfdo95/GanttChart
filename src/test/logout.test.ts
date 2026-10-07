import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_LOGOUT_PATH, completeLogout, startLogout, type LogoutDeps } from '../lib/auth/logout';
import { phaseAfterEnd } from '../app/sessionEnd';
import { LogoutButton, SignedOutScreen } from '../features/tenancy/LogoutButton';
import { SuperAdminConsole } from '../features/tenancy/SuperAdminConsole';
import { PublicLanding } from '../features/tenancy/PublicLanding';
import { AccessDenied } from '../features/tenancy/AccessDenied';
import { isSessionEnded } from '../features/tenancy/format';
import { ApiError, type TenancyApi } from '../lib/tenancy/api';
import type { PrincipalDto } from '../../shared/tenancy';
import logoutSource from '../lib/auth/logout.ts?raw';
import buttonSource from '../features/tenancy/LogoutButton.tsx?raw';
import appSource from '../app/App.tsx?raw';
import consoleSource from '../features/tenancy/SuperAdminConsole.tsx?raw';

interface Rig {
  deps: LogoutDeps;
  calls: string[];
  navigated: string[];
}

function rig(opts: { unsent?: number; saveFails?: boolean } = {}): Rig {
  const calls: string[] = [];
  const navigated: string[] = [];
  const deps: LogoutDeps = {
    unsentChanges: () => {
      calls.push('unsent?');
      return opts.unsent ?? 0;
    },
    saveLocal: async () => {
      calls.push('saveLocal');
      if (opts.saveFails === true) throw new Error('disk full');
    },
    stopSync: () => calls.push('stopSync'),
    endSession: () => calls.push('endSession'),
    navigate: (path) => {
      calls.push('navigate');
      navigated.push(path);
    },
  };
  return { deps, calls, navigated };
}

afterEach(() => vi.unstubAllGlobals());

describe('logout flow', () => {
  it('uses Cloudflare Access’s own endpoint on THIS origin (a relative path, nothing appended)', () => {
    expect(ACCESS_LOGOUT_PATH).toBe('/cdn-cgi/access/logout');
    expect(ACCESS_LOGOUT_PATH.startsWith('/')).toBe(true);
    expect(ACCESS_LOGOUT_PATH).not.toMatch(/[?#:]|\/\//); // no query, no fragment, no host, no redirect parameter
    expect(logoutSource).not.toMatch(/workers\.dev|https?:\/\//);
  });

  it('with nothing unsent: signs out immediately — stop sync, save the device copy, end the session, leave', async () => {
    const r = rig();
    expect(await startLogout(r.deps)).toEqual({ kind: 'done' });
    expect(r.calls).toEqual(['unsent?', 'stopSync', 'saveLocal', 'endSession', 'navigate']);
    expect(r.navigated).toEqual(['/cdn-cgi/access/logout']);
  });

  it('with unsent shared changes: warns first and does NOTHING else (the session and the sync stay active)', async () => {
    const r = rig({ unsent: 3 });
    expect(await startLogout(r.deps)).toEqual({ kind: 'confirm', unsent: 3 });
    expect(r.calls).toEqual(['unsent?']); // no stop, no save, no end, no navigation
    expect(r.navigated).toEqual([]);
  });

  it('Cancel is simply not calling completeLogout: nothing was stopped, so the session and sync continue', async () => {
    const r = rig({ unsent: 1 });
    await startLogout(r.deps);
    // (the dialog’s Cancel button only hides the dialog)
    expect(r.calls).not.toContain('stopSync');
    expect(r.calls).not.toContain('endSession');
    expect(r.calls).not.toContain('navigate');
  });

  it('a confirmed sign-out continues through the same safe path', async () => {
    const r = rig({ unsent: 5 });
    await startLogout(r.deps);
    await completeLogout(r.deps);
    expect(r.calls.slice(1)).toEqual(['stopSync', 'saveLocal', 'endSession', 'navigate']);
    expect(r.navigated).toEqual([ACCESS_LOGOUT_PATH]);
  });

  it('stops the live connection BEFORE anything else, and the session ends BEFORE the page is left', async () => {
    const r = rig();
    await completeLogout(r.deps);
    expect(r.calls.indexOf('stopSync')).toBeLessThan(r.calls.indexOf('saveLocal'));
    expect(r.calls.indexOf('endSession')).toBeLessThan(r.calls.indexOf('navigate'));
  });

  it('failing to save the device copy never traps the person in the app', async () => {
    const r = rig({ saveFails: true });
    await completeLogout(r.deps);
    expect(r.navigated).toEqual([ACCESS_LOGOUT_PATH]);
    expect(r.calls).toContain('endSession');
  });

  it('is the same path for every role: Super Admin, Admin and User', async () => {
    for (const role of ['super_admin', 'admin', 'user']) {
      const r = rig();
      await startLogout(r.deps);
      expect(r.calls, role).toEqual(['unsent?', 'stopSync', 'saveLocal', 'endSession', 'navigate']);
      expect(r.navigated, role).toEqual([ACCESS_LOGOUT_PATH]);
    }
  });

  it('is SELF sign-out only: nothing about a person, tenant or account is an input, and no API is called', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = rig({ unsent: 0 });
    await startLogout(r.deps);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.navigated[0]).toBe(ACCESS_LOGOUT_PATH); // exactly the constant: no user id, email or tenant id in it
    // The dependency surface has no parameter that could carry an identity.
    expect(Object.keys(r.deps).sort()).toEqual(['endSession', 'navigate', 'saveLocal', 'stopSync', 'unsentChanges']);
    for (const fn of [logoutSource, buttonSource]) expect(fn).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\/api\//);
  });

  it('never touches the device’s own data: no clearing, no unlinking, no preference or storage writes', () => {
    const forbidden = /clearAllLocalData|clearAll|deleteDatabase|localStorage|sessionStorage|indexedDB|removeItem|\.clear\(|unlinkDevice|writeLink|writeMirror|persistWorkspace|setLanguage/;
    for (const [name, src] of Object.entries({ logout: logoutSource, button: buttonSource })) expect(src, name).not.toMatch(forbidden);
    // The shell wiring passes only these five actions.
    const wiring = appSource.slice(appSource.indexOf('function ShellLogout'), appSource.indexOf('function Shell()'));
    expect(wiring).toContain('persistence.saveNow'); // saves, never clears
    // ... and wires every step of the flow to the real thing.
    expect(wiring).toContain('unsentChanges: sharedSync.unsentChanges');
    expect(wiring).toContain('stopSync: sharedSync.stopForSignOut');
    expect(wiring).toContain("endSession: () => session.endSession('logout')");
    expect(wiring).toContain('navigate: (path) => window.location.assign(path)');
    expect(wiring).not.toMatch(forbidden);
    const consoleWiring = consoleSource.slice(consoleSource.indexOf('<LogoutButton'), consoleSource.indexOf('/>', consoleSource.indexOf('<LogoutButton')));
    expect(consoleWiring).not.toMatch(forbidden);
  });
});

describe('how a session ends (one place for sign-out and expiry)', () => {
  it('sign-out shows the neutral signed-out screen; an ended sign-in shows the PUBLIC page with a notice', () => {
    expect(phaseAfterEnd('logout')).toEqual({ kind: 'signed-out' });
    expect(phaseAfterEnd('expired')).toEqual({ kind: 'landing', notice: 'sessionEnded' });
  });

  it('only a refusal because the sign-in is gone counts as an ended session — not a permission refusal', () => {
    expect(isSessionEnded(new ApiError(401, 'login_required', {}))).toBe(true);
    expect(isSessionEnded(new ApiError(401, 'Missing Access token', {}))).toBe(true);
    expect(isSessionEnded(new ApiError(403, 'Invalid Access token', {}))).toBe(true);
    expect(isSessionEnded(new ApiError(403, 'forbidden', {}))).toBe(false);
    expect(isSessionEnded(new ApiError(404, 'not_found', {}))).toBe(false);
    expect(isSessionEnded(new ApiError(409, 'email_taken', {}))).toBe(false);
    expect(isSessionEnded(new Error('x'))).toBe(false);
    expect(isSessionEnded(null)).toBe(false);
  });
});

describe('what each role sees', () => {
  const deps = rig().deps;
  const principal = (role: PrincipalDto['role']): PrincipalDto => ({
    email: 'someone@rakuten.com',
    userId: role === 'super_admin' ? null : 'usr_someone',
    isOwner: role === 'admin',
    displayName: null,
    role,
    tenant: role === 'super_admin' ? null : { id: 'ten_x', name: 'QA', storageMode: 'web', status: 'active', createdAt: 't', deletionRequestedAt: null },
    access: role === 'user' ? 'editor' : null,
    workspaceRole: role === 'super_admin' ? null : 'editor',
    sharedWorkspace: role !== 'super_admin',
  });
  const api = {} as unknown as TenancyApi;

  it('the Super Admin console shows Logout', () => {
    const html = renderToStaticMarkup(createElement(SuperAdminConsole, { initialLang: 'en', principal: principal('super_admin'), api }));
    expect(html).toContain('Logout');
  });

  it('the shared Logout control is what Admin and User shells render, in both languages', () => {
    for (const lang of ['en', 'ja'] as const) {
      const html = renderToStaticMarkup(createElement(LogoutButton, { lang, deps, who: principal('admin').email }));
      expect(html).toContain(lang === 'en' ? 'Logout' : 'サインアウト');
      expect(html).not.toContain('role="alertdialog"'); // the warning appears only when there is something to warn about
    }
    // The Admin/User shell mounts it for every signed-in non-Super-Admin principal; the console mounts the same component.
    expect(appSource).toContain('<LogoutButton');
    expect(appSource).toMatch(/principal === null \|\| principal\.role === 'super_admin'\) return null/);
    expect(consoleSource).toContain('<LogoutButton');
  });

  it('the public page and the no-account screen have NO sign-out control and no authenticated data', () => {
    const landing = renderToStaticMarkup(createElement(PublicLanding, { initialLang: 'en', notice: null }));
    const denied = renderToStaticMarkup(createElement(AccessDenied, { lang: 'en', reason: 'unregistered', email: 'e@rakuten.com', onRetry: () => undefined }));
    for (const html of [landing]) {
      expect(html).not.toContain('Logout');
      expect(html).not.toContain('cdn-cgi');
      expect(html).not.toMatch(/ten_|usr_/);
    }
    expect(denied).not.toContain('Logout');
  });

  it('after sign-out the screen shows no tenant or workspace data at all', () => {
    for (const lang of ['en', 'ja'] as const) {
      const html = renderToStaticMarkup(createElement(SignedOutScreen, { lang }));
      expect(html).toMatch(/Signing out|サインアウトしています/);
      expect(html).not.toMatch(/ten_|usr_|@|<button|<a /);
    }
  });

  it('a public landing after sign-out says only that the sign-in ended', () => {
    const html = renderToStaticMarkup(createElement(PublicLanding, { initialLang: 'en', notice: phaseAfterEnd('expired').kind === 'landing' ? 'sessionEnded' : null }));
    expect(html).toContain('Your sign-in has ended');
    expect(html).not.toMatch(/ten_|usr_|@/);
  });

  it('if Cloudflare did not handle the sign-out request, the person is told they may still be signed in', () => {
    const html = renderToStaticMarkup(createElement(PublicLanding, { initialLang: 'en', notice: 'logoutIncomplete' }));
    expect(html).toContain('may still be signed in');
  });
});
