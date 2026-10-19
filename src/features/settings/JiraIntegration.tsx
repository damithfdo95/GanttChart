import { useRef, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t } from '../../i18n';
import { createJiraClient, resolveJiraFlavor } from '../../lib/jira/client';
import type { JiraClientError, JiraConnection, JiraFlavor } from '../../../shared/jira';
import {
  connectionFromDraft,
  EMPTY_JIRA_DRAFT,
  isInsecureProxy,
  jiraDraftProblems,
  type JiraDraft,
} from './jiraSettingsForm';

/**
 * Settings → JIRA Integration (SV only, like the whole Settings screen).
 * The connection (including the token) is stored with the local settings —
 * the warning line below says so explicitly, and the token field is
 * write-only: a saved token is never echoed back into the input.
 */

export function JiraIntegration() {
  const lang = useAppStateCtx().state.language;
  const reports = useReportsStateCtx();
  const saved = reports.state.settings.jira;

  // Collapsed by default: connections are configured once — the status hint
  // shows whether one exists without expanding anything.
  const [open, setOpen] = useState(false);

  const [draft, setDraft] = useState<JiraDraft>({
    baseUrl: saved?.baseUrl ?? '',
    flavor: saved?.flavor ?? 'auto',
    email: saved?.email ?? '',
    token: '', // write-only: never pre-fill, never echo back
    proxyUrl: saved?.proxyUrl ?? '',
  });
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // The last token seen, so emptying the base URL (feature off) and typing it again does not lose it.
  const tokenStash = useRef<string | undefined>(saved?.token);
  if (saved?.token !== undefined) tokenStash.current = saved.token;

  const currentJiraOf = (d: JiraDraft): JiraConnection | undefined => connectionFromDraft(d, tokenStash.current);
  const currentJira = (): JiraConnection | undefined => currentJiraOf(draft);

  const commit = (patch: Partial<JiraDraft>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    // An unfinished (invalid) base URL is not saved; the previous connection stays until it is valid.
    if (jiraDraftProblems(next).baseUrl) return;
    reports.updateSettings({ jira: currentJiraOf(next) });
  };

  const clear = (): void => {
    setDraft(EMPTY_JIRA_DRAFT);
    tokenStash.current = undefined;
    setMessage(null);
    reports.updateSettings({ jira: undefined });
  };

  const removeToken = (): void => {
    tokenStash.current = undefined;
    const next = { ...draft, token: '' };
    setDraft(next);
    reports.updateSettings({ jira: connectionFromDraft(next, undefined) });
    setMessage({ kind: 'ok', text: t(lang, 'jira.tokenRemoved') });
  };

  const runTest = async (): Promise<void> => {
    const connection = currentJira();
    if (connection === undefined) {
      setMessage({ kind: 'error', text: t(lang, jiraDraftProblems(draft).baseUrl ? 'jira.baseUrlInvalid' : 'jira.testMissingBase') });
      return;
    }
    setTesting(true);
    setMessage(null);
    try {
      const client = createJiraClient(connection);
      const issues = await client.testConnection();
      setMessage({ kind: 'ok', text: t(lang, 'jira.testOk', { count: issues.length }) });
    } catch (e) {
      const err = e as JiraClientError;
      const hint = t(lang, `jira.error.${err.kind}`);
      const text = err.message !== undefined && err.message !== '' ? `${hint} — ${err.message}` : hint;
      setMessage({ kind: 'error', text });
    } finally {
      setTesting(false);
    }
  };

  const effective = currentJira();
  const resolvedFlavor = effective === undefined ? 'dc' : resolveJiraFlavor(effective, effective.baseUrl);
  const tokenSaved = (saved?.token ?? '') !== '';
  const problems = jiraDraftProblems(draft);

  return (
    <section className="dr-section" aria-labelledby="jira-title">
      <div className="dr-button-row">
        <h2 id="jira-title">{t(lang, 'jira.title')}</h2>
        <span className={`config-status${saved !== undefined ? ' config-status-ok' : ''}`}>
          {saved !== undefined ? `✓ ${t(lang, 'common.configured')}` : t(lang, 'common.notConfigured')}
        </span>
        <button
          type="button"
          className="btn btn-ghost panel-toggle"
          aria-expanded={open}
          aria-controls="jira-integration-body"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="panel-toggle-chevron" aria-hidden="true">{open ? '▼' : '▶'}</span>
          {t(lang, open ? 'common.collapse' : 'common.expand')}
        </button>
      </div>

      {open ? (
        <div id="jira-integration-body" className="panel-toggle-body">
          <p className="dr-summary">{t(lang, 'jira.help')}</p>

      <label className="settings-field">
        {t(lang, 'jira.baseUrl')}
        <input
          className="input"
          type="text"
          placeholder={t(lang, 'jira.baseUrlPlaceholder')}
          value={draft.baseUrl}
          aria-invalid={problems.baseUrl}
          onChange={(e) => commit({ baseUrl: e.target.value })}
        />
      </label>
      {problems.baseUrl ? <p className="field-error" role="alert">{t(lang, 'jira.baseUrlInvalid')}</p> : null}

      <label className="settings-field">
        {t(lang, 'jira.flavor')}
        <select className="input" value={draft.flavor} onChange={(e) => commit({ flavor: e.target.value as JiraFlavor })}>
          <option value="auto">{t(lang, 'jira.flavorAuto')}</option>
          <option value="cloud">{t(lang, 'jira.flavorCloud')}</option>
          <option value="dc">{t(lang, 'jira.flavorDc')}</option>
        </select>
      </label>

      {resolvedFlavor === 'cloud' ? (
        <label className="settings-field">
          {t(lang, 'jira.email')}
          <input
            className="input"
            type="text"
            autoComplete="off"
            value={draft.email}
            onChange={(e) => commit({ email: e.target.value })}
          />
        </label>
      ) : null}

      <label className="settings-field">
        {t(lang, 'jira.token')}
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={draft.token}
          placeholder={tokenSaved ? '••••••••' : ''}
          onChange={(e) => commit({ token: e.target.value })}
        />
      </label>
      <p className="dr-summary">
        {t(lang, 'jira.tokenHint')}
        {tokenSaved ? ` ${t(lang, 'jira.tokenSaved')}` : ''}
      </p>

      <label className="settings-field">
        {t(lang, 'jira.proxyUrl')}
        <input
          className="input"
          type="text"
          autoComplete="off"
          value={draft.proxyUrl}
          aria-invalid={problems.proxyUrl}
          onChange={(e) => commit({ proxyUrl: e.target.value })}
        />
      </label>
      {problems.proxyUrl ? <p className="field-error" role="alert">{t(lang, 'jira.proxyUrlInvalid')}</p> : null}
      {!problems.proxyUrl && isInsecureProxy(draft.proxyUrl) ? <p className="qa-warning" role="note">{t(lang, 'jira.proxyInsecure')}</p> : null}
      <p className="dr-summary">{t(lang, 'jira.proxyHint')}</p>

      <p className="dr-summary" role="note">
        {t(lang, 'jira.warning')}
      </p>

      <div className="dr-button-row">
        <button type="button" className="btn btn-primary" disabled={testing} onClick={() => void runTest()}>
          {testing ? t(lang, 'jira.testing') : t(lang, 'jira.test')}
        </button>
        {tokenSaved ? (
          <button type="button" className="btn btn-ghost" onClick={removeToken}>
            {t(lang, 'jira.removeToken')}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={clear}>
          {t(lang, 'jira.clear')}
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