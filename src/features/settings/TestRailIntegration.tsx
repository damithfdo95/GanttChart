import { useRef, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t } from '../../i18n';
import { createTestRailClient } from '../../lib/testrail/client';
import type { TestRailClientError, TestRailConnection } from '../../../shared/testrail';
import {
  testrailConnectionFromDraft,
  EMPTY_TESTRAIL_DRAFT,
  testrailDraftProblems,
  type TestRailDraft,
} from './testrailSettingsForm';
import { isInsecureProxy } from './jiraSettingsForm';

/**
 * Settings → TestRail Integration (SV only, like the whole Settings screen).
 * The connection (including the API key) is stored with the local settings —
 * the warning line below says so explicitly, and the key field is write-only:
 * a saved key is never echoed back into the input.
 */

export function TestRailIntegration() {
  const lang = useAppStateCtx().state.language;
  const reports = useReportsStateCtx();
  const saved = reports.state.settings.testrail;

  // Collapsed by default: connections are configured once — the status hint
  // shows whether one exists without expanding anything.
  const [open, setOpen] = useState(false);

  const [draft, setDraft] = useState<TestRailDraft>({
    baseUrl: saved?.baseUrl ?? '',
    email: saved?.email ?? '',
    apiKey: '', // write-only: never pre-fill, never echo back
    proxyUrl: saved?.proxyUrl ?? '',
  });
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // The last key seen, so emptying the base URL (feature off) and typing it
  // again does not lose it.
  const apiKeyStash = useRef<string | undefined>(saved?.apiKey);
  if (saved?.apiKey !== undefined) apiKeyStash.current = saved.apiKey;

  const currentTestrailOf = (d: TestRailDraft): TestRailConnection | undefined => testrailConnectionFromDraft(d, apiKeyStash.current);
  const currentTestrail = (): TestRailConnection | undefined => currentTestrailOf(draft);

  const commit = (patch: Partial<TestRailDraft>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    // An unfinished (invalid) base URL is not saved; the previous connection stays until it is valid.
    if (testrailDraftProblems(next).baseUrl) return;
    reports.updateSettings({ testrail: currentTestrailOf(next) });
  };

  const clear = (): void => {
    setDraft(EMPTY_TESTRAIL_DRAFT);
    apiKeyStash.current = undefined;
    setMessage(null);
    reports.updateSettings({ testrail: undefined });
  };

  const removeApiKey = (): void => {
    apiKeyStash.current = undefined;
    const next = { ...draft, apiKey: '' };
    setDraft(next);
    reports.updateSettings({ testrail: testrailConnectionFromDraft(next, undefined) });
    setMessage({ kind: 'ok', text: t(lang, 'testrail.apiKeyRemoved') });
  };

  const runTest = async (): Promise<void> => {
    const connection = currentTestrail();
    if (connection === undefined) {
      setMessage({ kind: 'error', text: t(lang, testrailDraftProblems(draft).baseUrl ? 'testrail.baseUrlInvalid' : 'testrail.testMissingBase') });
      return;
    }
    setTesting(true);
    setMessage(null);
    try {
      const client = createTestRailClient(connection);
      const count = await client.testConnection();
      setMessage({ kind: 'ok', text: t(lang, 'testrail.testOk', { count }) });
    } catch (e) {
      const err = e as TestRailClientError;
      const hint = t(lang, `testrail.error.${err.kind}`);
      const text = err.message !== undefined && err.message !== '' ? `${hint} — ${err.message}` : hint;
      setMessage({ kind: 'error', text });
    } finally {
      setTesting(false);
    }
  };

  const keySaved = (saved?.apiKey ?? '') !== '';
  const problems = testrailDraftProblems(draft);

  return (
    <section className="dr-section" aria-labelledby="testrail-title">
      <div className="dr-button-row">
        <h2 id="testrail-title">{t(lang, 'testrail.title')}</h2>
        <span className={`config-status${saved !== undefined ? ' config-status-ok' : ''}`}>
          {saved !== undefined ? `✓ ${t(lang, 'common.configured')}` : t(lang, 'common.notConfigured')}
        </span>
        <button
          type="button"
          className="btn btn-ghost panel-toggle"
          aria-expanded={open}
          aria-controls="testrail-integration-body"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="panel-toggle-chevron" aria-hidden="true">{open ? '▼' : '▶'}</span>
          {t(lang, open ? 'common.collapse' : 'common.expand')}
        </button>
      </div>

      {open ? (
        <div id="testrail-integration-body" className="panel-toggle-body">
          <p className="dr-summary">{t(lang, 'testrail.help')}</p>

      <label className="settings-field">
        {t(lang, 'testrail.baseUrl')}
        <input
          className="input"
          type="text"
          placeholder={t(lang, 'testrail.baseUrlPlaceholder')}
          value={draft.baseUrl}
          aria-invalid={problems.baseUrl}
          onChange={(e) => commit({ baseUrl: e.target.value })}
        />
      </label>
      {problems.baseUrl ? <p className="field-error" role="alert">{t(lang, 'testrail.baseUrlInvalid')}</p> : null}

      <label className="settings-field">
        {t(lang, 'testrail.email')}
        <input
          className="input"
          type="text"
          autoComplete="off"
          value={draft.email}
          onChange={(e) => commit({ email: e.target.value })}
        />
      </label>

      <label className="settings-field">
        {t(lang, 'testrail.apiKey')}
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={draft.apiKey}
          placeholder={keySaved ? '••••••••' : ''}
          onChange={(e) => commit({ apiKey: e.target.value })}
        />
      </label>
      <p className="dr-summary">
        {t(lang, 'testrail.apiKeyHint')}
        {keySaved ? ` ${t(lang, 'testrail.apiKeySaved')}` : ''}
      </p>

      <label className="settings-field">
        {t(lang, 'testrail.proxyUrl')}
        <input
          className="input"
          type="text"
          autoComplete="off"
          value={draft.proxyUrl}
          aria-invalid={problems.proxyUrl}
          onChange={(e) => commit({ proxyUrl: e.target.value })}
        />
      </label>
      {problems.proxyUrl ? <p className="field-error" role="alert">{t(lang, 'testrail.proxyUrlInvalid')}</p> : null}
      {!problems.proxyUrl && isInsecureProxy(draft.proxyUrl) ? <p className="qa-warning" role="note">{t(lang, 'testrail.proxyInsecure')}</p> : null}
      <p className="dr-summary">{t(lang, 'testrail.proxyHint')}</p>

      <p className="dr-summary" role="note">
        {t(lang, 'testrail.warning')}
      </p>

      <div className="dr-button-row">
        <button type="button" className="btn btn-primary" disabled={testing} onClick={() => void runTest()}>
          {testing ? t(lang, 'testrail.testing') : t(lang, 'testrail.test')}
        </button>
        {keySaved ? (
          <button type="button" className="btn btn-ghost" onClick={removeApiKey}>
            {t(lang, 'testrail.removeApiKey')}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={clear}>
          {t(lang, 'testrail.clear')}
        </button>
      </div>

      {message === null ? null : (
        <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
        </div>
      ) : null}
    </section>
  );
}
