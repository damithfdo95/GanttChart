/**
 * The forced password change: shown when the SV-set initial password is still
 * in place. The person cannot use the app until they choose their own.
 *
 * It posts to /api/auth/change-password with the current (initial) password and
 * the new one. On success the session is refreshed (the Worker revoked the
 * other sessions, not this one) and the app reloads.
 */

import { useState } from 'react';
import { t } from '../../i18n';
import type { Language } from '../../types';

const MIN_PASSWORD_LENGTH = 10;

export function ChangePasswordScreen({ lang }: { lang: Language }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'wrong' | 'short' | 'mismatch' | 'network' | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError('short');
      return;
    }
    if (next !== confirm) {
      setError('mismatch');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-gc-intent': 'change-password' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (res.ok) {
        window.location.assign('/');
        return;
      }
      setError(res.status === 401 ? 'wrong' : res.status === 400 ? 'short' : 'network');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="link-screen">
      <form className="link-card login-card" onSubmit={(e) => void submit(e)}>
        <h1>{t(lang, 'pwchange.title')}</h1>
        <p>{t(lang, 'pwchange.explain')}</p>
        {error === 'wrong' ? (
          <p role="alert">{t(lang, 'pwchange.wrong')}</p>
        ) : error === 'short' ? (
          <p role="alert">{t(lang, 'pwchange.short', { min: String(MIN_PASSWORD_LENGTH) })}</p>
        ) : error === 'mismatch' ? (
          <p role="alert">{t(lang, 'pwchange.mismatch')}</p>
        ) : error === 'network' ? (
          <p role="alert">{t(lang, 'login.network')}</p>
        ) : null}
        <label className="login-field">
          <span>{t(lang, 'pwchange.current')}</span>
          <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy} autoFocus />
        </label>
        <label className="login-field">
          <span>{t(lang, 'pwchange.new')}</span>
          <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={next} onChange={(e) => setNext(e.target.value)} disabled={busy} />
        </label>
        <label className="login-field">
          <span>{t(lang, 'pwchange.confirm')}</span>
          <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
        </label>
        <div className="link-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t(lang, 'login.busy') : t(lang, 'pwchange.submit')}
          </button>
        </div>
      </form>
    </main>
  );
}
