import { useState } from 'react';
import { completeLogout, startLogout, type LogoutDeps } from '../../lib/auth/logout';
import { t } from '../../i18n';
import type { Language } from '../../types';

/**
 * The one sign-out control, used by every role (Super Admin console, Admin and User shell).
 * Rendered only for a signed-in person; the page shown to an anonymous visitor never has it.
 *
 * Unsent shared changes are never dropped silently: the first click only asks; "Sign out
 * anyway" is the single way to continue, "Cancel" leaves the session and the sync untouched.
 */
export function LogoutButton({ lang, deps, who }: { lang: Language; deps: LogoutDeps; who?: string }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const click = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const started = await startLogout(deps);
      if (started.kind === 'confirm') setAsking(true);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    await completeLogout(deps);
  };

  return (
    <span className="logout-control">
      <button type="button" className="btn btn-ghost logout-button" onClick={() => void click()} disabled={busy} title={who}>
        {t(lang, 'logout.button')}
      </button>
      {asking ? (
        <div className="app-banner logout-confirm" role="alertdialog" aria-labelledby="logout-confirm-title" aria-describedby="logout-confirm-body">
          <div className="app-banner-body">
            <strong id="logout-confirm-title">{t(lang, 'logout.title')}</strong>
            <span id="logout-confirm-body">{t(lang, 'logout.unsentWarning')}</span>
            <span>{t(lang, 'logout.deviceKept')}</span>
          </div>
          <div className="app-banner-actions">
            <button type="button" className="btn btn-primary" onClick={() => setAsking(false)} disabled={busy}>
              {t(lang, 'logout.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={busy}>
              {t(lang, 'logout.confirm')}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

/** What the browser shows between "sign out" and Cloudflare's own sign-out page: no data, nothing to click. */
export function SignedOutScreen({ lang }: { lang: Language }) {
  return (
    <main className="link-screen">
      <div className="link-card">
        <p role="status">{t(lang, 'logout.signingOut')}</p>
      </div>
    </main>
  );
}
