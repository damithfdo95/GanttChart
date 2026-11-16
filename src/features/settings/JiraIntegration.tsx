import { useEffect, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t } from '../../i18n';
import { createServerJiraClient, resolveJiraFlavor } from '../../lib/jira/client';
import type { JiraClientError, JiraFlavor } from '../../../shared/jira';
import {
  EMPTY_JIRA_DRAFT,
  isInsecureProxy,
  jiraDraftProblems,
  type JiraDraft,
} from './jiraSettingsForm';

/**
 * Settings → JIRA Integration (SV only, like the whole Settings screen).
 * Credentials are write-only and stored encrypted by the tenant Worker.
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
  const [saving, setSaving] = useState(false);
  const [serverConfigured, setServerConfigured] = useState(false);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void fetch('/api/tenant/integrations/jira', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(async (r) => r.ok ? r.json() as Promise<{ configured?: boolean; baseUrl?: string; jiraType?: JiraFlavor; lastVerifiedAt?: string | null }> : null)
      .then((status) => {
        if (status === null) return;
        setServerConfigured(status.configured === true);
        setLastVerifiedAt(status.lastVerifiedAt ?? null);
        if (status.configured && status.baseUrl) setDraft((d) => ({ ...d, baseUrl: status.baseUrl ?? d.baseUrl, flavor: status.jiraType ?? d.flavor, proxyUrl: '' }));
      }).catch(() => undefined);
  }, []);

  const commit = (patch: Partial<JiraDraft>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
  };

  const clear = (): void => {
    setDraft(EMPTY_JIRA_DRAFT);
    setMessage(null);
    void removeServer();
  };

  const removeServer = async (): Promise<void> => {
    const response = await fetch('/api/tenant/integrations/jira', { method: 'DELETE', credentials: 'same-origin', headers: { Accept: 'application/json', 'X-GC-Intent': 'ui' } });
    if (response.ok) { setServerConfigured(false); setLastVerifiedAt(null); reports.updateSettings({ jira: undefined }); }
  };

  const save = async (): Promise<void> => {
    const problems = jiraDraftProblems(draft);
    if (problems.baseUrl || draft.baseUrl.trim() === '' || draft.token.trim() === '') { setMessage({ kind: 'error', text: t(lang, 'jira.testMissingBase') }); return; }
    setSaving(true); setMessage(null);
    try {
      const response = await fetch('/api/tenant/integrations/jira', {
        method: 'PUT', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-GC-Intent': 'ui' },
        body: JSON.stringify({ baseUrl: draft.baseUrl, jiraType: draft.flavor, email: draft.email, token: draft.token }),
      });
      if (!response.ok) throw new Error('save_failed');
      setServerConfigured(true);
      setDraft((d) => ({ ...d, token: '', proxyUrl: '' }));
      // Non-secret compatibility marker keeps existing navigation/import surfaces enabled; legacy token/proxy are removed.
      reports.updateSettings({ jira: { baseUrl: draft.baseUrl.trim(), flavor: draft.flavor, ...(draft.email.trim() === '' ? {} : { email: draft.email.trim() }) } });
      setMessage({ kind: 'ok', text: t(lang, 'jira.tokenSaved') });
    } catch { setMessage({ kind: 'error', text: t(lang, 'jira.error.server') }); }
    finally { setSaving(false); }
  };

  const runTest = async (): Promise<void> => {
    if (!serverConfigured) {
      setMessage({ kind: 'error', text: t(lang, jiraDraftProblems(draft).baseUrl ? 'jira.baseUrlInvalid' : 'jira.testMissingBase') });
      return;
    }
    setTesting(true);
    setMessage(null);
    try {
      const client = createServerJiraClient();
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

  const resolvedFlavor = resolveJiraFlavor({ baseUrl: draft.baseUrl, flavor: draft.flavor }, draft.baseUrl);
  const legacyToken = (saved?.token ?? '') !== '';
  const problems = jiraDraftProblems(draft);

  return (
    <section className="dr-section" aria-labelledby="jira-title">
      <div className="dr-button-row">
        <h2 id="jira-title">{t(lang, 'jira.title')}</h2>
        <span className={`config-status${serverConfigured ? ' config-status-ok' : ''}`}>
          {serverConfigured ? `✓ ${t(lang, 'common.configured')}` : t(lang, 'common.notConfigured')}
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
      {problems.baseUrl ? <p className="field-error" role="alert">{t(lang, isInsecureProxy(draft.baseUrl) ? 'jira.baseUrlInsecure' : 'jira.baseUrlInvalid')}</p> : null}

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
          placeholder={serverConfigured ? '••••••••' : ''}
          onChange={(e) => commit({ token: e.target.value })}
        />
      </label>
      <p className="dr-summary">
        {t(lang, 'jira.tokenHint')}
        {serverConfigured ? ` ${t(lang, 'jira.tokenSaved')}` : ''}
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
      {problems.proxyUrl ? <p className="field-error" role="alert">{t(lang, isInsecureProxy(draft.proxyUrl) ? 'jira.proxyInsecure' : 'jira.proxyUrlInvalid')}</p> : null}
      <p className="dr-summary">{t(lang, 'jira.proxyHint')}</p>

      <p className="dr-summary" role="note">
        {t(lang, 'jira.warning')}
        {legacyToken ? ` ${t(lang, 'jira.secureReconnect')}` : ''}
        {lastVerifiedAt ? ` ${t(lang, 'jira.lastVerified')}: ${lastVerifiedAt}` : ''}
      </p>

      <div className="dr-button-row">
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? t(lang, 'save.saving') : t(lang, serverConfigured ? 'jira.replaceCredential' : 'jira.saveCredential')}
        </button>
        <button type="button" className="btn btn-primary" disabled={testing} onClick={() => void runTest()}>
          {testing ? t(lang, 'jira.testing') : t(lang, 'jira.test')}
        </button>
        {serverConfigured ? (
          <button type="button" className="btn btn-ghost" onClick={() => void removeServer()}>
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
