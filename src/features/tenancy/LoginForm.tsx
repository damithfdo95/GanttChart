/**
 * The sign-in form (the Worker's own password sign-in, which replaced
 * Cloudflare Access).
 *
 * It posts to /signin. On success the Worker has set the session
 * cookie and the browser is sent to "/" (the app). A `mustChangePassword`
 * answer means the password was set by an SV and must be replaced now.
 *
 * The page makes NO request for data and offers NO way to register: accounts
 * (and their initial passwords) are created by an administrator.
 */

import { useState } from 'react';
import { t } from '../../i18n';
import type { Language } from '../../types';
import type { LandingNotice } from '../../app/sessionEnd';
import { ACCESS_LOGIN_PATH, PASSWORD_LOGIN_PATH } from '../../../shared/routes';

export function LoginForm({ lang, initialEmail = '', notice = null }: { lang: Language; initialEmail?: string; notice?: LandingNotice }) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'invalid' | 'locked' | 'network' | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(PASSWORD_LOGIN_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-gc-intent': 'signin' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        // The cookie is set; the app decides what to show (including a forced password change).
        window.location.assign('/');
        return;
      }
      if (res.status === 423) setError('locked');
      else if (res.status === 401 || res.status === 400) setError('invalid');
      else setError('network');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="link-screen">
      <form className="link-card login-card" onSubmit={(e) => void submit(e)}>
        <h1>{t(lang, 'login.title')}</h1>
        <p className="landing-tagline">
          <strong>{t(lang, 'landing.tagline')}</strong>
        </p>
        {notice === 'logoutIncomplete' ? <p role="alert">{t(lang, 'landing.logoutIncomplete')}</p> : null}
        {error === 'invalid' ? (
          <p role="alert">{t(lang, 'login.invalid')}</p>
        ) : error === 'locked' ? (
          <p role="alert">{t(lang, 'login.locked')}</p>
        ) : error === 'network' ? (
          <p role="alert">{t(lang, 'login.network')}</p>
        ) : null}
        <label className="login-field">
          <span>{t(lang, 'login.email')}</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>
        <label className="login-field">
          <span>{t(lang, 'login.password')}</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>
        <div className="link-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t(lang, 'login.busy') : t(lang, 'landing.signIn')}
          </button>
        </div>
        <p className="link-help">
          <a href={ACCESS_LOGIN_PATH}>{t(lang, 'login.ssoInstead')}</a>
        </p>
        <p className="link-help">{t(lang, 'login.noAccountHelp')}</p>
      </form>
    </main>
  );
}
