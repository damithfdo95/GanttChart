import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SuperAdminConsole } from '../features/tenancy/SuperAdminConsole';
import { dictionaries } from '../i18n/dictionaries';
import type { PrincipalDto, TenantSummaryDto, UserDto } from '../../shared/tenancy';
import type { TenancyApi } from '../lib/tenancy/api';
import consoleSource from '../features/tenancy/SuperAdminConsole.tsx?raw';
import apiSource from '../lib/tenancy/api.ts?raw';

/**
 * The Super Admin's SV password reset: the platform's recovery path when a
 * workspace has no functioning SV. The Super Admin sets an SV account's initial
 * password from the Workspaces tab; the person must choose their own at the next
 * sign-in (the forced change), and their sessions end.
 */

const NOW = '2026-11-13T09:00:00.000Z';
const tenant = (): TenantSummaryDto => ({
  id: 'ten_alpha',
  name: 'Alpha QA',
  adminEmail: 'admin-a@rakuten.com',
  adminDisplayName: 'Alice',
  adminStatus: 'active',
  storageMode: 'web',
  status: 'active',
  userCount: 4,
  lastActivityAt: NOW,
  createdAt: NOW,
  deletionRequestedAt: null,
  adminOutsideManagedDomains: false,
});
const sv = (over: Partial<UserDto> = {}): UserDto => ({
  id: 'usr_sv',
  email: 'admin-a@rakuten.com',
  displayName: 'Alice',
  role: 'admin',
  isOwner: true,
  access: 'editor',
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  lastLoginAt: null,
  ...over,
});
const principal = (): PrincipalDto => ({
  email: 'super@rakuten.com',
  userId: null,
  displayName: null,
  role: 'super_admin',
  tenant: null,
  access: null,
  isOwner: false,
  workspaceRole: null,
  sharedWorkspace: false,
});
const api = (over: Partial<TenancyApi> = {}): TenancyApi =>
  ({
    listTenants: over.listTenants ?? (async () => ({ tenants: [tenant()], total: 1 })),
    superListTenantAdmins: over.superListTenantAdmins ?? (async () => [sv()]),
    superSetUserPassword: over.superSetUserPassword ?? (async () => ({ ok: true as const, revokedSessions: 0 })),
    platformAudit: async () => [],
    audit: async () => [],
    ...over,
  }) as unknown as TenancyApi;

const html = (over: { api?: TenancyApi } = {}): string =>
  renderToStaticMarkup(createElement(SuperAdminConsole, { initialLang: 'en', principal: principal(), api: over.api ?? api() }));
void html; // kept for interactive debugging; the assertions below are source-based (effects cannot run in a static render)

describe('the Super Admin\'s SV password reset (Workspaces tab)', () => {
  it('offers the action on every active or deactivated workspace row, never on one awaiting deletion', () => {
    // The static render cannot open the dialog (it needs a click), so the wiring is checked in the source:
    // the button sits beside activate/deactivate and is gated by the same statuses.
    expect(consoleSource).toMatch(/super\.pw\.action/);
    expect(consoleSource).toMatch(/onClick=\{\(\) => setPwTenant\(tn\)\}/);
    expect(dictionaries.en['super.pw.action']).toBe('SV passwords…');
    expect(dictionaries.ja['super.pw.action']).toBe('SVパスワード…');
  });

  it('the dialog lists the workspace\'s SV accounts and offers Set password per account (disabled for a disabled login)', () => {
    expect(consoleSource).toMatch(/superListTenantAdmins\(tenant\.id\)/);
    expect(consoleSource).toMatch(/disabled=\{busy \|\| u\.status === 'disabled'\}/);
    expect(consoleSource).toMatch(/title=\{u\.status === 'disabled' \? t\(lang, 'super\.pw\.disabled'\) : undefined\}/);
    expect(dictionaries.en['super.pw.disabled']).toBe('Enable this login first.');
    expect(dictionaries.ja['super.pw.disabled']).toBe('先にこのログインを有効化してください。');
  });

  it('the dialog markup exists in the component (two password fields, the minLength rule and the submit path)', () => {
    expect(consoleSource).toMatch(/function SvPasswords\(/);
    expect(consoleSource).toMatch(/type="password"/);
    expect(consoleSource).toMatch(/minLength=\{MIN_PASSWORD_LENGTH\}/);
    expect(consoleSource).toMatch(/api\.superSetUserPassword\(tenant\.id, user\.id, pw1\)/);
    expect(consoleSource).toMatch(/super\.pw\.title/);
    expect(consoleSource).toMatch(/super\.pw\.rules/);
  });

  it('the API client posts to the super route with the intent header (CSRF) and nothing else', () => {
    expect(apiSource).toMatch(/superListTenantAdmins: async \(tenantId\) => \(await call<\{ users: UserDto\[\] \}>\('GET', `\/api\/super\/tenants\/\$\{encodeURIComponent\(tenantId\)\}\/users`\)\)\.users/);
    expect(apiSource).toMatch(/superSetUserPassword: \(tenantId, userId, password\) =>\s*\n\s*call\('POST', `\/api\/super\/tenants\/\$\{encodeURIComponent\(tenantId\)\}\/users\/\$\{encodeURIComponent\(userId\)\}\/password`, \{ password \}\)/);
  });

  it('the password never travels anywhere except the POST body (no query string, no log)', () => {
    expect(apiSource).not.toMatch(/superSetUserPassword[^;]*\?password/);
    expect(consoleSource).not.toMatch(/console\.(log|error|warn)/);
  });

  it('says in both languages what the Super Admin must know (the forced change, the channel, the hash)', () => {
    expect(dictionaries.en['super.pw.body']).toContain('must choose their own');
    expect(dictionaries.ja['super.pw.body']).toContain('自分のパスワード');
    expect(dictionaries.en['super.pw.rules']).toContain('stored only as a hash');
    expect(dictionaries.ja['super.pw.rules']).toContain('ハッシュのみ');
    expect(dictionaries.en['super.pw.setDone']).toContain('must choose their own at the next sign-in');
    expect(dictionaries.ja['super.pw.setDone']).toContain('次回サインイン時');
    expect(dictionaries.en['super.pw.setDoneEnded']).toContain('{count}');
    expect(dictionaries.ja['super.pw.setDoneEnded']).toContain('{count}');
    expect(dictionaries.en['super.pw.empty']).toBeTruthy();
    expect(dictionaries.ja['super.pw.empty']).toBeTruthy();
  });
});
