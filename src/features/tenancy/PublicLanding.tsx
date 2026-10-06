import { useEffect, useState } from 'react';
import { t, LANGUAGES } from '../../i18n';
import type { LandingNotice } from '../../app/sessionEnd';
import type { Language } from '../../types';

/**
 * The public page: what anyone sees at the site address before signing in.
 *
 * It is static text and one link. It makes NO request for data, offers NO way to
 * register or ask for an account (accounts are created by an administrator), and
 * "Sign in" is a plain link to /login — the address Cloudflare Access protects —
 * so the sign-in itself is always done by Access, never by this page.
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
          <a className="btn btn-primary" href="/login">
            {t(lang, 'landing.signIn')}
          </a>
        </div>
        <p className="link-help">{t(lang, 'landing.signInHelp')}</p>
        <p className="link-help">{t(lang, 'landing.noAccountHelp')}</p>
      </div>
    </main>
  );
}
