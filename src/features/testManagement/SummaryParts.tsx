import { t, type TranslationKey } from '../../i18n';
import type { CaseSummary } from '../../domain/testManagement';
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
