import { useCallback, useEffect, useState } from 'react';
import { useTenant } from '../../app/tenant-context';
import { t, type TranslationKey } from '../../i18n';
import type { TesterDto } from '../../../shared/tenancy';
import { highestSeverity, type CycleRiskSignal, type ExecutionMetrics, type RiskSignal } from '../../domain/qaMetrics';
import type { Language } from '../../types';

/** May this person administer cycles and assignments? The Admin, or someone using the app on their own (no accounts). */
export function useIsQaAdmin(): boolean {
  const { principal } = useTenant();
  return principal === null || principal.role === 'admin';
}

/**
 * The Tester accounts of this workspace (names and status), for showing and assigning people. Only exists in Web
 * storage; null while loading or when there is no roster to show.
 */
export function useTesters(): { testers: TesterDto[] | null; reload: () => void } {
  const { principal, api } = useTenant();
  const [testers, setTesters] = useState<TesterDto[] | null>(null);
  const available = principal !== null && principal.sharedWorkspace && api !== null;
  const reload = useCallback(() => {
    if (!available || api === null) return;
    api.team().then(setTesters, () => setTesters(null));
  }, [available, api]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { testers: available ? testers : null, reload };
}

const SEVERITY_SYMBOL = { attention: '⚠', warning: '△', info: 'ℹ' } as const;

/** A risk signal in words with a symbol: never colour alone. */
export function RiskList({ lang, signals }: { lang: Language; signals: ReadonlyArray<RiskSignal | CycleRiskSignal> }) {
  if (signals.length === 0) return <span className="risk-ok">{t(lang, 'risk.none')}</span>;
  return (
    <ul className="risk-list">
      {signals.map((s) => (
        <li key={s.code} className={`risk risk-${s.severity}`}>
          <span aria-hidden="true">{SEVERITY_SYMBOL[s.severity]} </span>
          <span className="sr-only">{t(lang, `risk.severity.${s.severity}` as TranslationKey)}: </span>
          {t(lang, `risk.${s.code}` as TranslationKey, { value: s.value ?? 0 })}
        </li>
      ))}
    </ul>
  );
}

/** One compact badge: the most serious level, or "OK". */
export function RiskBadge({ lang, signals }: { lang: Language; signals: ReadonlyArray<RiskSignal | CycleRiskSignal> }) {
  const level = highestSeverity(signals);
  if (level === null) return <span className="risk-badge risk-ok">{t(lang, 'risk.badge.ok')}</span>;
  return (
    <span className={`risk-badge risk-${level}`}>
      <span aria-hidden="true">{SEVERITY_SYMBOL[level]} </span>
      {t(lang, `risk.badge.${level}` as TranslationKey)}
    </span>
  );
}

export function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

const n = (v: number): string => v.toLocaleString('en-US');

/** The execution numbers of a project, cycle or portfolio, labelled in words. */
export function MetricsGrid({ lang, m }: { lang: Language; m: ExecutionMetrics }) {
  const cells: Array<{ key: TranslationKey; value: string; hint?: TranslationKey }> = [
    { key: 'qa.planned', value: n(m.planned) },
    { key: 'qa.executed', value: n(m.executed), hint: 'qa.executedHint' },
    { key: 'qa.passed', value: n(m.passed) },
    { key: 'qa.failed', value: n(m.failed) },
    { key: 'qa.blocked', value: n(m.blocked), hint: 'qa.blockedHint' },
    { key: 'qa.remaining', value: n(m.remaining) },
    { key: 'qa.completion', value: percent(m.completion), hint: 'qa.completionHint' },
    { key: 'qa.passRate', value: percent(m.passRate), hint: 'qa.passRateHint' },
  ];
  return (
    <div className="overall-summary qa-metrics" role="group" aria-label={t(lang, 'qa.metricsTitle')}>
      {cells.map((c) => (
        <div key={c.key} className="summary-card" title={c.hint === undefined ? undefined : t(lang, c.hint)}>
          <span className="summary-card-label">{t(lang, c.key)}</span>
          <span className="summary-card-value">{c.value}</span>
        </div>
      ))}
      {m.warnings.map((w) => (
        <p key={w} role="note" className="qa-warning">
          <span aria-hidden="true">⚠ </span>
          {t(lang, `qa.warning.${w}` as TranslationKey)}
        </p>
      ))}
    </div>
  );
}
