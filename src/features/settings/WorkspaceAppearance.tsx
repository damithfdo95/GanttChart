import { useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { TOOL_NAME_MAX, cleanToolName, toolNameOf } from '../../domain/branding';
import { t } from '../../i18n';

/**
 * Settings → Workspace Appearance (SV only, like the whole Settings screen): this workspace's own name for the tool. It is part of
 * the shared settings, so everyone in the workspace sees it after signing in; the public sign-in page keeps the platform name.
 */
export function WorkspaceAppearance() {
  const lang = useAppStateCtx().state.language;
  const reports = useReportsStateCtx();
  const current = reports.state.settings.toolName ?? '';
  const [draft, setDraft] = useState(current);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const save = (): void => {
    if (draft.trim() === '') {
      reports.updateSettings({ toolName: undefined });
      setDraft('');
      setMessage({ kind: 'ok', text: t(lang, 'settings.appearance.cleared') });
      return;
    }
    const clean = cleanToolName(draft);
    if (clean === null) {
      setMessage({ kind: 'error', text: t(lang, 'settings.appearance.invalid', { max: TOOL_NAME_MAX }) });
      return;
    }
    reports.updateSettings({ toolName: clean });
    setDraft(clean);
    setMessage({ kind: 'ok', text: t(lang, 'settings.appearance.saved') });
  };

  return (
    <section className="dr-section" aria-labelledby="appearance-title">
      <h2 id="appearance-title">{t(lang, 'settings.appearance.title')}</h2>
      <p className="dr-summary">{t(lang, 'settings.appearance.help')}</p>
      <label className="settings-field">
        {t(lang, 'settings.appearance.toolName')}
        <input className="input" type="text" value={draft} maxLength={TOOL_NAME_MAX} placeholder={t(lang, 'app.title')} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <p className="dr-summary">
        {t(lang, 'settings.appearance.preview')}: <strong>{toolNameOf({ toolName: draft }, lang)}</strong>
      </p>
      <div className="dr-button-row">
        <button type="button" className="btn btn-primary" onClick={save}>
          {t(lang, 'settings.appearance.save')}
        </button>
      </div>
      {message === null ? null : (
        <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      <p className="link-help">{t(lang, 'settings.appearance.logoNote')}</p>
    </section>
  );
}
