import { useEffect, useState } from 'react';
import { t, type TranslationKey } from '../../i18n';
import { parseTotalInput, type CaseSummary, type ProjectTotals } from '../../domain/testManagement';
import type { Language } from '../../types';

/** 0.8123 -> "81.2%"; no denominator -> "—" (never NaN or #DIV/0!). */
export function pct(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '—' : `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
}

const COUNTS = ['pass', 'fail', 'na', 'blocked', 'spo', 'retest', 'question', 'remaining'] as const;

/** One scope's (or the project's) numbers, laid out like the spreadsheet's summary block. Every number is calculated; none is typed. */
export function SummaryBlock({ lang, summary }: { lang: Language; summary: CaseSummary }) {
  return (
    <dl className="tm-summary" aria-label={t(lang, 'tm.sum.title')}>
      <div>
        <dt>{t(lang, 'tm.sum.total')}</dt>
        <dd>{summary.total}</dd>
      </div>
      <div>
        <dt>{t(lang, 'tm.sum.started')}</dt>
        <dd>{summary.started}</dd>
      </div>
      <div>
        <dt>{t(lang, 'tm.sum.progress')}</dt>
        <dd>{pct(summary.progress)}</dd>
      </div>
      <div title={t(lang, 'tm.sum.passRateHint')}>
        <dt>{t(lang, 'tm.sum.passRate')}</dt>
        <dd>{pct(summary.passRate)}</dd>
      </div>
      {COUNTS.map((k) => (
        <div key={k}>
          <dt>{t(lang, `tm.sum.${k}` as TranslationKey)}</dt>
          <dd>{summary[k]}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The authoritative numbers of one project: the typed Total Test Cases, how many detailed cases are registered, and the overall
 * execution taken from the aggregate (Stage 8A) model. Registering cases never changes the Total; a surplus is only warned about.
 */
export function TotalsPanel({ lang, totals, completed }: { lang: Language; totals: ProjectTotals; completed: number }) {
  const remaining = Math.max(totals.total - completed, 0);
  const progress = totals.total > 0 ? Math.min(1, completed / totals.total) : null;
  return (
    <div className="tm-totals">
      <h3>{t(lang, 'tm.overview.aggregateTitle')}</h3>
      <dl className="tm-summary" aria-label={t(lang, 'tm.overview.aggregateTitle')}>
        <div>
          <dt>{t(lang, 'tm.total.title')}</dt>
          <dd>{totals.total}</dd>
        </div>
        <div>
          <dt>{t(lang, 'tm.total.registered')}</dt>
          <dd>{totals.registered}</dd>
        </div>
        <div>
          <dt>{t(lang, 'tm.total.completedAgg')}</dt>
          <dd>{completed}</dd>
        </div>
        <div>
          <dt>{t(lang, 'tm.total.remainingAgg')}</dt>
          <dd>{remaining}</dd>
        </div>
        <div>
          <dt>{t(lang, 'tm.total.progressAgg')}</dt>
          <dd>{pct(progress)}</dd>
        </div>
      </dl>
      <p className="link-help">{t(lang, 'tm.total.help')}</p>
      {totals.source === 'project' && totals.activeScopes > 0 ? <p className="link-help">{t(lang, 'tm.total.projectOwn', { total: totals.total })}</p> : null}
      {totals.source === 'scopes' && totals.scopesWithoutTotal > 0 ? <p className="link-help">{t(lang, 'tm.total.missing', { count: totals.scopesWithoutTotal })}</p> : null}
      <RegisteredWarning lang={lang} totals={totals} />
    </div>
  );
}

/** "137 active Test Cases are registered, but Total Test Cases is set to 134." Words and a symbol, never colour alone. */
export function RegisteredWarning({ lang, totals }: { lang: Language; totals: ProjectTotals }) {
  if (!totals.overRegistered) return null;
  return (
    <div className="tm-warning" role="status">
      {totals.source === 'project' ? (
        <strong>
          <span aria-hidden="true">⚠ </span>
          {t(lang, 'tm.total.warnOver', { registered: totals.registered, total: totals.total })}
        </strong>
      ) : (
        totals.scopes
          .filter((r) => r.overRegistered)
          .map((r) => (
            <strong key={r.scope.id} className="tm-warning-line">
              <span aria-hidden="true">⚠ </span>
              {r.scope.name}: {t(lang, 'tm.total.warnOver', { registered: r.registered, total: r.total ?? 0 })}
            </strong>
          ))
      )}
      <span className="link-help"> {t(lang, 'tm.total.warnOverHint')}</span>
    </div>
  );
}

/**
 * The Total Test Cases of ONE scope, typed by an SV. Saved when the field is left or Enter is pressed (one revision, never one per
 * keystroke); an unchanged value writes nothing; an empty field means "not set".
 */
export function ScopeTotalInput({ lang, value, label, onCommit }: { lang: Language; value: number | undefined; label: string; onCommit: (next: number | null) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value === undefined ? '' : String(value));
    setInvalid(false);
  }, [value]);
  const commit = (): void => {
    const parsed = parseTotalInput(text);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed === value) return;
    onCommit(parsed === undefined ? null : parsed);
  };
  return (
    <span className="tm-total-input">
      <input
        className="input"
        inputMode="numeric"
        value={text}
        placeholder={t(lang, 'tm.total.unset')}
        aria-label={label}
        aria-invalid={invalid}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {invalid ? (
        <span role="alert" className="link-help">
          {t(lang, 'tm.total.invalid')}
        </span>
      ) : null}
    </span>
  );
}
