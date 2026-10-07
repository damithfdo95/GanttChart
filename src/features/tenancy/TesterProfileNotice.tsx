import { t } from '../../i18n';
import type { Language } from '../../types';

/**
 * Shown to a Tester whose account is not linked to a Team Member profile (every Tester created before profiles existed).
 * Tickets still work; performance rows need the profile. Nothing is guessed from their name: an SV links them in Team Members.
 */
export function TesterProfileNotice({ lang }: { lang: Language }) {
  return (
    <div className="app-banner" role="alert">
      <div className="app-banner-body">
        <strong>{t(lang, 'tester.profileNotLinked.title')}</strong>
        <span>{t(lang, 'tester.profileNotLinked.body')}</span>
      </div>
    </div>
  );
}
