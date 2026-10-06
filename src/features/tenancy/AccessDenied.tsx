import { t, type TranslationKey } from '../../i18n';
import type { DenyReason } from '../../../shared/tenancy';
import type { Language } from '../../types';

/** Shown to someone who is signed in with Access but not granted access by the application. No data, no local fallback. */
export function AccessDenied({ lang, reason, email, onRetry }: { lang: Language; reason: DenyReason; email: string; onRetry: () => void }) {
  return (
    <main className="link-screen">
      <div className="link-card">
        <h1>{t(lang, 'tenancy.denied.title')}</h1>
        {email === '' ? null : <p>{t(lang, 'tenancy.denied.signedInAs', { email })}</p>}
        <p role="alert">{t(lang, `tenancy.denied.${reason}` as TranslationKey)}</p>
        <div className="link-actions">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {t(lang, 'tenancy.denied.retry')}
          </button>
        </div>
      </div>
    </main>
  );
}
