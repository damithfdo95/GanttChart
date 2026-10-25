import { t, type TranslationKey } from '../../i18n';
import { formatInteger } from '../../lib/formatting/format';
import type { WorkMixRow } from '../../domain/qaWork';
import type { Language } from '../../types';

/** The current QA work of the project by kind of work (Regression / Sanity / Adhoc / Verification / unspecified): a compact read-only list. */
export function WorkMixCard({ lang, rows }: { lang: Language; rows: readonly WorkMixRow[] }) {
  return (
    <section className="dr-section work-mix" aria-label={t(lang, 'qa.workMix.title')}>
      <h3>{t(lang, 'qa.workMix.title')}</h3>
      {rows.length === 0 ? (
        <p className="exec-help">{t(lang, 'qa.workMix.empty')}</p>
      ) : (
        <ul className="work-mix-list">
          {rows.map((r) => (
            <li key={r.workType}>
              <span className={`tag qa-worktype qa-worktype-${r.workType}`}>{t(lang, `qa.workType.${r.workType}` as TranslationKey)}</span>{' '}
              <strong>{t(lang, 'qa.workMix.cases', { n: formatInteger(r.cases, lang) })}</strong>{' '}
              <span className="exec-help">{t(lang, 'qa.workMix.scopes', { n: r.scopes })}</span>
            </li>
          ))}
        </ul>
      )}
      {rows.some((r) => r.workType === 'verification') ? <p className="exec-help">{t(lang, 'qa.workMix.verificationNote')}</p> : null}
    </section>
  );
}
