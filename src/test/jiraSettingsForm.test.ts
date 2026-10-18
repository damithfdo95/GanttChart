import { describe, expect, it } from 'vitest';
import { connectionFromDraft, EMPTY_JIRA_DRAFT, isInsecureProxy, jiraDraftProblems } from '../features/settings/jiraSettingsForm';

const draft = (over = {}) => ({ ...EMPTY_JIRA_DRAFT, baseUrl: 'https://acme.atlassian.net', ...over });

describe('connectionFromDraft', () => {
  it('is off without a valid http(s) base URL', () => {
    expect(connectionFromDraft(EMPTY_JIRA_DRAFT, 'tok')).toBeUndefined();
    expect(connectionFromDraft(draft({ baseUrl: 'jira.acme.com' }), 'tok')).toBeUndefined();
    expect(jiraDraftProblems(draft({ baseUrl: 'jira.acme.com' })).baseUrl).toBe(true);
    expect(jiraDraftProblems(EMPTY_JIRA_DRAFT).baseUrl).toBe(false);
  });

  it('an emptied email or proxy is really removed, and auto really means auto', () => {
    const conn = connectionFromDraft(draft({ flavor: 'auto', email: '', proxyUrl: '' }), 'tok');
    expect(conn).toStrictEqual({ baseUrl: 'https://acme.atlassian.net', token: 'tok' });
  });

  it('only the token falls back to the saved one; a typed token replaces it', () => {
    expect(connectionFromDraft(draft(), 'old')?.token).toBe('old');
    expect(connectionFromDraft(draft({ token: ' new ' }), 'old')?.token).toBe('new');
    expect(connectionFromDraft(draft(), undefined)?.token).toBeUndefined();
  });

  it('keeps explicit values and drops an invalid proxy', () => {
    expect(connectionFromDraft(draft({ flavor: 'cloud', email: ' a@b.c ', proxyUrl: 'https://p.example.com' }), undefined)).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      flavor: 'cloud',
      email: 'a@b.c',
      proxyUrl: 'https://p.example.com',
    });
    expect(connectionFromDraft(draft({ proxyUrl: 'proxy.example.com' }), undefined)?.proxyUrl).toBeUndefined();
    expect(jiraDraftProblems(draft({ proxyUrl: 'proxy.example.com' })).proxyUrl).toBe(true);
  });
});

describe('isInsecureProxy', () => {
  it('flags plain http except on this computer', () => {
    expect(isInsecureProxy('http://proxy.example.com')).toBe(true);
    expect(isInsecureProxy('https://proxy.example.com')).toBe(false);
    expect(isInsecureProxy('http://localhost:8787')).toBe(false);
    expect(isInsecureProxy('http://127.0.0.1:8787/x')).toBe(false);
    expect(isInsecureProxy('http://localhost.evil.com')).toBe(true);
  });
});
