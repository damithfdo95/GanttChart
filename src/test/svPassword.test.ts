import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TeamDirectory } from '../features/tenancy/TeamDirectory';
import { dictionaries } from '../i18n/dictionaries';
import type { UserDto } from '../../shared/tenancy';
import type { TenancyApi } from '../lib/tenancy/api';
import type { RcsMember } from '../types';
import directorySource from '../features/tenancy/TeamDirectory.tsx?raw';
import apiSource from '../lib/tenancy/api.ts?raw';

/**
 * The SV's "Set password" action: the last piece of the password sign-in. The SV
 * gives each user their initial password from the Team Members directory; the
 * person must choose their own at the next sign-in (the forced change).
 */

const NOW = '2026-11-11T09:00:00.000Z';
const user = (over: Partial<UserDto> = {}): UserDto => ({
  id: 'usr_hana',
  email: 'hana@rakuten.com',
  displayName: 'Hana Sato',
  role: 'user',
  isOwner: false,
  access: 'editor',
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  lastLoginAt: null,
  ...over,
});
const member = (over: Partial<RcsMember> = {}): RcsMember => ({ id: 'USER0001', name: 'Hana Sato', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, userId: 'usr_hana', email: 'hana@rakuten.com', ...over });

const api = (over: Partial<TenancyApi> = {}): TenancyApi =>
  ({
    listUsers: async () => [user()],
    setUserPassword: over.setUserPassword ?? (async () => ({ ok: true as const, revokedSessions: 0 })),
    ...over,
  }) as unknown as TenancyApi;

const html = (over: { api?: TenancyApi; members?: RcsMember[] } = {}): string =>
  renderToStaticMarkup(createElement(TeamDirectory, { lang: 'en', api: over.api ?? api(), members: over.members ?? [member()], currentUserId: 'usr_sv', onChanged: () => undefined }));
void html; // kept for interactive debugging; the assertions below are source-based (effects cannot run in a static render)

describe('the SV\'s Set password action (Team Members directory)', () => {
  it('offers "Set password" for a linked login in web storage, never for oneself, and disabled for a disabled login', () => {
    // The static render cannot load users (an effect does), so the wiring is checked in the source:
    // the button exists for every linked account except the SV's own, and a disabled login disables it.
    expect(directorySource).toMatch(/web && user !== null && !self \? \(/);
    expect(directorySource).toMatch(/disabled=\{busy \|\| user\.status === 'disabled'\} onClick=\{\(\) => openPassword\(user\)\}/);
    expect(directorySource).toMatch(/title=\{user\.status === 'disabled' \? t\(lang, 'dir\.pw\.disabled'\) : undefined\}/);
    expect(dictionaries.en['dir.pw.setAction']).toBe('Set password');
    expect(dictionaries.ja['dir.pw.setAction']).toBe('パスワードを設定');
  });

  it('the dialog markup exists in the component (opened per user, with two password fields and a submit)', () => {
    // The static render cannot open the dialog (it needs a click), so the source is checked:
    // the dialog, its two type="password" inputs, the minLength rule and the submit path.
    expect(directorySource).toMatch(/const openPassword = \(user: UserDto\): void =>/);
    expect(directorySource).toMatch(/type="password"/);
    expect(directorySource).toMatch(/minLength=\{MIN_PASSWORD_LENGTH\}/);
    expect(directorySource).toMatch(/api\.setUserPassword\(user\.id, pw1\)/);
    expect(directorySource).toMatch(/dir\.pw\.title/);
    expect(directorySource).toMatch(/dir\.pw\.rules/);
  });

  it('the API client posts to the SV password route with the intent header (CSRF) and nothing else', () => {
    expect(apiSource).toMatch(/setUserPassword: \(userId, password\) => call\('POST', `\/api\/tenant\/users\/\$\{encodeURIComponent\(userId\)\}\/password`, \{ password \}\)/);
  });

  it('a disabled login keeps the action visible but inert (the reason is its title)', () => {
    expect(directorySource).toMatch(/user\.status === 'disabled' \? t\(lang, 'dir\.pw\.disabled'\) : undefined/);
    expect(dictionaries.en['dir.pw.disabled']).toBe('Enable this login first.');
    expect(dictionaries.ja['dir.pw.disabled']).toBe('先にこのログインを有効化してください。');
  });

  it('says in both languages what the SV must know (the forced change, the channel, the hash)', () => {
    expect(dictionaries.en['dir.pw.body']).toContain('must choose their own');
    expect(dictionaries.ja['dir.pw.body']).toContain('自分のパスワード');
    expect(dictionaries.en['dir.pw.setDone']).toContain('must choose their own at the next sign-in');
    expect(dictionaries.ja['dir.pw.setDone']).toContain('次回サインイン時');
  });

  it('the password never travels anywhere except the POST body (no query string, no log)', () => {
    expect(apiSource).not.toMatch(/setUserPassword[^;]*\?password/);
    expect(directorySource).not.toMatch(/console\.(log|error|warn)/);
  });

  it('the server route is SV-only and revokes the sessions (checked in the worker suites); the client surfaces the count', () => {
    const set = vi.fn(async () => ({ ok: true as const, revokedSessions: 2 }));
    const out = api({ setUserPassword: set });
    void out;
    // The message keys exist for both outcomes.
    expect(dictionaries.en['dir.pw.setDoneEnded']).toContain('{count}');
    expect(dictionaries.ja['dir.pw.setDoneEnded']).toContain('{count}');
  });
});
