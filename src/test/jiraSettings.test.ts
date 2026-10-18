import { describe, expect, it } from 'vitest';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { defaultReportsState, isJiraConnection, isReportsState, normalizeReportsState } from '../lib/storage/reports';
import { DEMO_STATE } from '../lib/storage/storage';
import type { ReportsState } from '../types';
import type { JiraConnection } from '../../shared/jira';

const withJira = (jira: unknown): ReportsState => ({
  ...defaultReportsState(),
  settings: { ...defaultReportsState().settings, jira: jira as JiraConnection | undefined },
});

describe('ReportSettings.jira storage', () => {
  it('no jira field by default (feature off until configured)', () => {
    const state = defaultReportsState();
    expect(state.settings.jira).toBeUndefined();
    expect('jira' in state.settings).toBe(false);
  });

  it('isJiraConnection validates the persisted shape', () => {
    expect(isJiraConnection({ baseUrl: 'https://acme.atlassian.net' })).toBe(true);
    expect(isJiraConnection({ baseUrl: 'https://acme.atlassian.net', flavor: 'cloud', email: 'e', token: 't', proxyUrl: 'https://p.example' })).toBe(true);
    expect(isJiraConnection({ baseUrl: 42 })).toBe(false);
    expect(isJiraConnection({ flavor: 'cloud' })).toBe(false); // no base URL
    expect(isJiraConnection({ baseUrl: 'https://x', flavor: 'edition' })).toBe(false);
    expect(isJiraConnection(null)).toBe(false);
  });

  it('isReportsState accepts settings with a valid jira connection', () => {
    expect(isReportsState(withJira({ baseUrl: 'https://acme.atlassian.net', token: 'tok' }))).toBe(true);
    expect(isReportsState(withJira({ baseUrl: 'https://acme.atlassian.net', flavor: 'dc' }))).toBe(true);
  });

  it('an object-shaped jira field never rejects the whole state (self-healing)', () => {
    // Malformed values are sanitized away by normalization instead of
    // locking the user out with a reset-to-defaults.
    expect(isReportsState(withJira({ baseUrl: 'ftp://broken', token: 42 }))).toBe(true);
    expect(isReportsState(withJira({}))).toBe(true);
    // Truly non-object garbage still fails the settings guard.
    expect(isReportsState(withJira(42))).toBe(false);
    expect(isReportsState(withJira('jira'))).toBe(false);
  });

  it('normalization discards a connection whose base URL is missing or not http(s)', () => {
    expect(normalizeReportsState(withJira({ baseUrl: 'garbage', token: 'tok' })).settings.jira).toBeUndefined();
    expect(normalizeReportsState(withJira({ baseUrl: 'ftp://files.example', token: 'tok' })).settings.jira).toBeUndefined();
    expect(normalizeReportsState(withJira({ baseUrl: '   ' })).settings.jira).toBeUndefined();
    expect(normalizeReportsState(withJira({ flavor: 'cloud', token: 'tok' })).settings.jira).toBeUndefined();
  });

  it('normalization trims URLs and drops empty strings', () => {
    const normalized = normalizeReportsState(
      withJira({ baseUrl: '  https://acme.atlassian.net//  ', email: '   ', token: '  tok-cloud  ', proxyUrl: '' }),
    ).settings.jira as JiraConnection;
    expect(normalized).toEqual({ baseUrl: 'https://acme.atlassian.net//', token: 'tok-cloud' });
  });

  it('valid values pass through with the flavor preserved and a valid proxy kept', () => {
    const normalized = normalizeReportsState(
      withJira({ baseUrl: 'https://jira.acme.local', flavor: 'dc', token: 'tok', proxyUrl: 'https://proxy.example.com/jira' }),
    ).settings.jira as JiraConnection;
    expect(normalized).toEqual({ baseUrl: 'https://jira.acme.local', flavor: 'dc', token: 'tok', proxyUrl: 'https://proxy.example.com/jira' });
  });

  it('a proxy URL without http(s) is dropped, the rest of the connection survives', () => {
    const normalized = normalizeReportsState(
      withJira({ baseUrl: 'https://acme.atlassian.net', flavor: 'cloud', email: 'e@example.com', token: 't', proxyUrl: 'ftp://bad.example' }),
    ).settings.jira as JiraConnection;
    expect(normalized).toEqual({ baseUrl: 'https://acme.atlassian.net', flavor: 'cloud', email: 'e@example.com', token: 't' });
  });

  it('backups never carry the connection (it holds a credential and is device-local)', () => {
    const jira: JiraConnection = { baseUrl: 'https://acme.atlassian.net', flavor: 'cloud', email: 'sv@example.com', token: 'tok', proxyUrl: 'https://proxy.example.com' };
    const state = withJira(jira);
    const payload = createBackupPayload(DEMO_STATE, state);
    const parsed = parseBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.reportsState.settings.jira).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('tok');
      const reexported = JSON.stringify(createBackupPayload(DEMO_STATE, parsed.data.reportsState));
      expect(parseBackupPayload(reexported).ok).toBe(true);
    }
  });
});