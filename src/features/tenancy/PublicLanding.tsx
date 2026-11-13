import { useEffect, useState } from 'react';
import { t, LANGUAGES } from '../../i18n';
import type { LandingNotice } from '../../app/sessionEnd';
import type { Language } from '../../types';
import { ACCESS_LOGIN_PATH, PASSWORD_LOGIN_PATH } from '../../../shared/routes';

/**
 * The public page: what anyone sees at the site address before signing in.
 *
 * It is static text and two links. It makes NO request for data, offers NO way to
 * register or ask for an account (accounts are created by an administrator).
 * "Sign in with SSO" goes to /login — the address Cloudflare Access protects —
 * and "Sign in with a password" to /signin, the Worker's own form. Either one
 * is a complete sign-in; the person picks what works for them.
 */
export function PublicLanding({ initialLang, notice }: { initialLang: Language; notice: LandingNotice }) {
  const [lang, setLang] = useState<Language>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = `${t(lang, 'landing.title')} — ${t(lang, 'landing.tagline')}`;
  }, [lang]);

  return (
    <main className="link-screen">
      <div className="link-card landing-card">
        <div className="dr-button-row" role="group" aria-label={t(lang, 'landing.language')}>
          {LANGUAGES.map((option) => (
            <button key={option.code} type="button" className={`btn ${option.code === lang ? 'btn-primary' : ''}`} aria-pressed={option.code === lang} onClick={() => setLang(option.code)}>
              {option.short}
            </button>
          ))}
        </div>
        <h1>{t(lang, 'landing.title')}</h1>
        <p className="landing-tagline">
          <strong>{t(lang, 'landing.tagline')}</strong>
        </p>
        <p>{t(lang, 'landing.description')}</p>
        {notice === 'signInFailed' ? <p role="alert">{t(lang, 'landing.signInFailed')}</p> : null}
        {notice === 'sessionEnded' ? <p role="status">{t(lang, 'landing.sessionEnded')}</p> : null}
        {notice === 'logoutIncomplete' ? <p role="alert">{t(lang, 'landing.logoutIncomplete')}</p> : null}
        <div className="link-actions">
          <a className="btn btn-primary" href={ACCESS_LOGIN_PATH}>
            {t(lang, 'landing.signInSso')}
          </a>
          <a className="btn" href={PASSWORD_LOGIN_PATH}>
            {t(lang, 'landing.signInPassword')}
          </a>
        </div>
        <p className="link-help">{t(lang, 'landing.signInHelp')}</p>
        <p className="link-help">{t(lang, 'landing.noAccountHelp')}</p>
      </div>
    </main>
  );
}
