import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PublicLanding } from '../features/tenancy/PublicLanding';
import landingSource from '../features/tenancy/PublicLanding.tsx?raw';
import { AccessDenied } from '../features/tenancy/AccessDenied';
import { dictionaries } from '../i18n/dictionaries';

const REGISTRATION_EN = /\b(register|registration|sign ?up|create (an |your |a )?account|request (an |your |a )?account|join)\b/i;
const REGISTRATION_JA = /新規登録|会員登録|サインアップ|アカウント(を)?(作成|申請|登録)(する|できます|はこちら)|アカウント申請/;

describe('the public page', () => {
  const html = (lang: 'en' | 'ja', failed = false): string => renderToStaticMarkup(createElement(PublicLanding, { initialLang: lang, notice: failed ? 'signInFailed' : null }));

  it('shows the product, a short description, the language choice and ONE sign-in link to /login', () => {
    const en = html('en');
    expect(en).toContain('GanttChart');
    expect(en).toContain('Internal QA test-execution management');
    expect(en).toContain('EN');
    expect(en).toContain('日本語');
    expect((en.match(/<a /g) ?? []).length).toBe(1);
    expect(en).toContain('href="/login"');
    expect(en).toContain('Sign in');
  });

  it('is Japanese when asked to be', () => {
    const ja = html('ja');
    expect(ja).toContain('社内QAテスト実行管理');
    expect(ja).toContain('サインイン');
    expect(ja).toContain('href="/login"');
  });

  it('has NO registration, account request, invitation or any input at all', () => {
    for (const lang of ['en', 'ja'] as const) {
      const page = html(lang, true).replace(/<[^>]+>/g, ' ');
      expect(page, lang).not.toMatch(REGISTRATION_EN);
      expect(page, lang).not.toMatch(REGISTRATION_JA);
      const markup = html(lang, true);
      expect(markup).not.toMatch(/<(form|input|textarea|select)\b/i);
    }
  });

  it('explains that accounts come from an administrator, and reports a failed sign-in without detail', () => {
    expect(html('en')).toContain('Accounts are added by an SV of your workspace');
    const failed = html('en', true);
    expect(failed).toContain('Sign-in could not be completed');
    expect(html('en', false)).not.toContain('Sign-in could not be completed');
  });

  it('makes no request of its own and does not touch storage', () => {
    expect(landingSource).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB/);
  });

  it('every landing string avoids registration wording in both languages', () => {
    for (const [lang, dict] of Object.entries(dictionaries)) {
      for (const [key, value] of Object.entries(dict as Record<string, string>)) {
        if (!key.startsWith('landing.') && !key.startsWith('tenancy.denied.')) continue;
        expect(value, `${lang} ${key}`).not.toMatch(REGISTRATION_EN);
        expect(value, `${lang} ${key}`).not.toMatch(REGISTRATION_JA);
      }
    }
  });
});

describe('the "no account" screen for an authenticated but unregistered identity', () => {
  const markup = (lang: 'en' | 'ja'): string => renderToStaticMarkup(createElement(AccessDenied, { lang, reason: 'unregistered', email: 'employee@rakuten.com', onRetry: () => undefined }));

  it('says the identity was verified but there is no account, and who creates accounts', () => {
    const en = markup('en');
    expect(en).toContain('Your identity was verified, but you do not have a GanttChart account.');
    expect(en).toContain('Accounts are added by an SV of your workspace');
    expect(markup('ja')).toContain('アカウントがありません');
  });

  it('shows only the person’s own address — no tenant, no administrator, no other person', () => {
    for (const lang of ['en', 'ja'] as const) {
      const text = markup(lang);
      expect(text).not.toMatch(/ten_|usr_|admin@|administrator@/i);
      expect((text.match(/@/g) ?? []).length).toBe(1); // only their own address
    }
  });
});
