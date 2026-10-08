import { useRef, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { LOGO_LIMITS, LOGO_MIME_TYPES, checkLogo, type BrandingRecord } from '../../../shared/branding';
import { DEFAULT_PLAN_RETENTION_DAYS, RETENTION_CHOICES } from '../../../shared/meeting';
import { ApiError } from '../../lib/tenancy/api';
import { shrinkLogo } from '../../lib/branding/shrinkLogo';
import { BrandMark, useLogo } from '../branding/BrandMark';
import { t, type TranslationKey } from '../../i18n';
import { dictionaries } from '../../i18n/dictionaries';

/**
 * Settings -> Workspace Appearance (logo) and Data Retention. The logo is shrunk in the browser, then stored by the server after it checks the
 * type, the real file signature and the size again. In Local storage it is kept with the workspace on this device.
 */
export function WorkspaceLogo() {
  const lang = useAppStateCtx().state.language;
  const reports = useReportsStateCtx();
  const { api, principal } = useTenant();
  const shared = api !== null && principal !== null && principal.sharedWorkspace;
  const hasLogo = useLogo() !== null;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const fail = (code: string): void => {
    const key = `branding.error.${code}` as TranslationKey;
    setMessage({ kind: 'error', text: key in dictionaries.en ? t(lang, key) : t(lang, 'branding.error.generic') });
  };

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const small = await shrinkLogo(file);
      if (shared) await api.setLogo(small.mime, small.data);
      else {
        const check = checkLogo(small.mime, small.data);
        if (!check.ok) throw Object.assign(new Error(check.error), { code: check.error });
        const record: BrandingRecord = { id: 'branding', mime: small.mime as BrandingRecord['mime'], data: small.data, bytes: check.bytes, updatedAt: new Date().toISOString(), updatedByUserId: 'local' };
        reports.setBrandings([record]);
      }
      setMessage({ kind: 'ok', text: t(lang, 'branding.saved') });
    } catch (e) {
      fail(e instanceof ApiError ? e.code : ((e as { code?: string }).code ?? 'generic'));
    } finally {
      setBusy(false);
      if (input.current !== null) input.current.value = '';
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      if (shared) await api.removeLogo();
      else reports.setBrandings([]);
      setMessage({ kind: 'ok', text: t(lang, 'branding.removed') });
    } catch (e) {
      fail(e instanceof ApiError ? e.code : 'generic');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dr-section" aria-labelledby="logo-title">
      <h2 id="logo-title">{t(lang, 'branding.logo')}</h2>
      <p className="dr-summary">{t(lang, 'branding.help')}</p>
      <div className="branding-preview">{hasLogo ? <BrandMark lang={lang} className="brand-logo brand-logo-large" /> : <span className="link-help">{t(lang, 'branding.none')}</span>}</div>
      <p className="link-help">{t(lang, 'branding.formats', { types: LOGO_MIME_TYPES.map((m) => m.replace('image/', '').toUpperCase()).join(', '), kb: Math.round(LOGO_LIMITS.maxBytes / 1024), side: LOGO_LIMITS.maxSide })}</p>
      <div className="dr-button-row">
        <label className="btn btn-primary">
          {t(lang, 'branding.upload')}
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f !== undefined) void upload(f);
            }}
          />
        </label>
        <button type="button" className="btn btn-ghost" disabled={busy || !hasLogo} onClick={() => void remove()}>
          {t(lang, 'branding.remove')}
        </button>
      </div>
      {message === null ? null : (
        <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </section>
  );
}

export function DataRetention() {
  const lang = useAppStateCtx().state.language;
  const reports = useReportsStateCtx();
  const current = reports.state.settings.planRetentionDays ?? DEFAULT_PLAN_RETENTION_DAYS;
  return (
    <section className="dr-section" aria-labelledby="retention-title">
      <h2 id="retention-title">{t(lang, 'retention.title')}</h2>
      <p className="dr-summary">{t(lang, 'retention.help')}</p>
      <label className="settings-field">
        {t(lang, 'retention.plans')}
        <select className="input" value={current} onChange={(e) => reports.updateSettings({ planRetentionDays: Number(e.target.value) })}>
          {RETENTION_CHOICES.map((d) => (
            <option key={d} value={d}>
              {t(lang, 'retention.days', { days: d })}
              {d === DEFAULT_PLAN_RETENTION_DAYS ? ` (${t(lang, 'retention.default')})` : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="link-help">{t(lang, 'retention.note')}</p>
    </section>
  );
}
