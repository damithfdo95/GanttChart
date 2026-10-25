import { MetricCard } from '../../components/MetricCard';
import { t, type TranslationKey } from '../../i18n';
import { formatInteger } from '../../lib/formatting/format';
import { attentionItems, readinessBadgeKey, type ReadinessCategory, type ReadinessReason, type ReleaseReadiness } from '../../domain/readiness';
import { readinessPolicyNote, readinessReasonText } from './readinessText';
import type { Language } from '../../types';

const ICON: Record<ReturnType<typeof readinessBadgeKey>, string> = { ready: '✔', atRisk: '⚠', blocked: '⛔', notStarted: '○', onHold: '⏸', completed: '✔' };

/** A compact state badge: always an icon AND a word, never colour alone. */
export function ReadinessBadge({ lang, readiness }: { lang: Language; readiness: ReleaseReadiness }) {
  const key = readinessBadgeKey(readiness);
  return (
    <span className={`readiness-badge readiness-${key}`} title={readiness.reasons.filter((r) => r.severity !== 'info').map((r) => readinessReasonText(lang, r)).join('\n')}>
      <span aria-hidden="true">{ICON[key]} </span>
      {t(lang, `readiness.state.${key}` as TranslationKey)}
    </span>
  );
}

/** Reasons grouped by category, in the domain's order (highest-value first). */
function groups(reasons: readonly ReadinessReason[]): Array<{ category: ReadinessCategory; items: ReadinessReason[] }> {
  const out: Array<{ category: ReadinessCategory; items: ReadinessReason[] }> = [];
  for (const r of reasons) {
    const g = out.find((x) => x.category === r.category);
    if (g === undefined) out.push({ category: r.category, items: [r] });
    else g.items.push(r);
  }
  return out;
}

/**
 * Release Readiness: the state AND why. Blocking reasons and warnings are listed (grouped by category); informational evidence notes
 * stay folded away. It is current-state, read-only and derived - it never writes anything.
 */
export function ReadinessCard({ lang, readiness }: { lang: Language; readiness: ReleaseReadiness }) {
  const key = readinessBadgeKey(readiness);
  const important = readiness.reasons.filter((r) => r.severity !== 'info');
  const attention = attentionItems(readiness);
  const info = readiness.reasons.filter((r) => r.severity === 'info' && !attention.includes(r));
  const blocking = important.filter((r) => r.severity === 'blocking').length;
  const warnings = important.length - blocking;
  const m = readiness.metrics;
  const lifecycleOnly = readiness.applicability !== 'evaluated' && important.length === 0;
  return (
    <section className={`readiness-card readiness-card-${key}`} aria-label={t(lang, 'readiness.title')}>
      <div className="readiness-head">
        <h3>{t(lang, 'readiness.title')}</h3>
        <ReadinessBadge lang={lang} readiness={readiness} />
        {!lifecycleOnly && important.length > 0 ? <span className="exec-help">{t(lang, 'readiness.summary', { blocking, warnings })}</span> : null}
      </div>
      {lifecycleOnly ? null : important.length === 0 ? (
        <p className="exec-help">{t(lang, 'readiness.noReasons')}</p>
      ) : (
        <div className="readiness-reasons">
          {groups(important).map((g) => (
            <div key={g.category} className="readiness-group">
              <div className="readiness-group-title">{t(lang, `readiness.category.${g.category}` as TranslationKey)}</div>
              <ul>
                {g.items.map((r) => (
                  <li key={r.code} className={`readiness-reason readiness-reason-${r.severity}`}>
                    {readinessReasonText(lang, r)}
                    {readinessPolicyNote(lang, r) === null ? null : <span className="exec-help readiness-policy-note"> {readinessPolicyNote(lang, r)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {readiness.applicability === 'evaluated' || important.length > 0 ? (
        <div className="metrics-grid readiness-metrics">
          <MetricCard label={t(lang, 'readiness.metric.progress')} value={m.progress === null ? '—' : `${Math.round(m.progress * 100)}%`} />
          <MetricCard label={t(lang, 'readiness.metric.failedBlocked')} value={`${formatInteger(m.failed, lang)} / ${formatInteger(m.blocked, lang)}`} />
          <MetricCard label={t(lang, 'readiness.metric.scheduleDelta')} value={m.daysLate === null ? t(lang, 'readiness.metric.onTime') : t(lang, 'readiness.metric.daysLate', { n: m.daysLate })} tone={m.daysLate === null ? 'default' : 'warn'} />
          <MetricCard label={t(lang, 'readiness.metric.staffingGap')} value={formatInteger(Math.max(0, m.staffingGap), lang)} />
        </div>
      ) : null}
      {attention.length > 0 ? (
        <div className="readiness-attention">
          <div className="readiness-group-title">{t(lang, 'readiness.attention.title')}</div>
          <ul>
            {attention.map((r) => (
              <li key={r.code}>{readinessReasonText(lang, r)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {info.length > 0 ? (
        <details className="readiness-info">
          <summary>{t(lang, 'readiness.infoToggle', { n: info.length })}</summary>
          <ul>
            {info.map((r) => (
              <li key={r.code}>{readinessReasonText(lang, r)}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="exec-help">
        {t(lang, 'readiness.currentNote')} {t(lang, 'readiness.policy.label')}: {t(lang, readiness.policyCustom ? 'readiness.policy.custom' : 'readiness.policy.default')}
      </p>
    </section>
  );
}
