import { t, type TranslationKey } from '../i18n';
import type { Language } from '../types';

/**
 * What a screen says in an empty workspace: why it is empty and the ONE useful next action (never a blank card). The action is a
 * navigation, not a data change.
 */
export function FirstUseNotice({ lang, bodyKey, onAction }: { lang: Language; bodyKey: TranslationKey; onAction: () => void }) {
  return (
    <section className="dr-section first-use" aria-labelledby="first-use-title">
      <h2 id="first-use-title">{t(lang, 'firstUse.title')}</h2>
      <p>{t(lang, bodyKey)}</p>
      <div className="dr-button-row">
        <button type="button" className="btn btn-primary" onClick={onAction}>
          {t(lang, 'firstUse.action')}
        </button>
      </div>
    </section>
  );
}
