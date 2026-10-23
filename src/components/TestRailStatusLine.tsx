import { t } from '../i18n';
import { formatInteger, formatNumber } from '../lib/formatting/format';
import { passedPct, type TestRailRunProgress } from '../../shared/testrail';
import type { Language } from '../types';

/**
 * The live TestRail status line, rendered as BOLD text with one color per
 * status so the numbers are readable at a glance (the plain-text locale
 * line was hard to scan):
 *
 * - Passed → green, Blocked → orange, Retest → yellow, Failed → red,
 *   Untested → black (the default text color), N/A (custom statuses) →
 *   gray, passed rate → light green.
 *
 * The label order follows each locale's own sentence (en: "3 Passed, …",
 * ja: "合格 3件、…"), so the markup stays translatable — only the colors
 * and the bold weight are fixed. Used by the Dashboard Execution section,
 * the Test Management scope progress line and the per-tester breakdown.
 *
 * N/A note: TestRail has no built-in N/A — instances define it as a custom
 * status (id 6+, custom_status1_count…). Those land in the `custom` bucket
 * and count toward `total`, so the line MUST show them or the numbers
 * never add up.
 */
export function TestRailStatusLine({ lang, progress, className }: { lang: Language; progress: TestRailRunProgress; className?: string }) {
  const pct = Math.round(passedPct(progress) * 100);
  return (
    <span className={`testrail-status-line${className === undefined ? '' : ` ${className}`}`}>
      <strong className="tsl-passed">
        {t(lang, 'tm.testrailProgress.count.passed', { count: formatInteger(progress.passed, lang) })}
      </strong>
      <strong className="tsl-blocked">
        {t(lang, 'tm.testrailProgress.count.blocked', { count: formatInteger(progress.blocked, lang) })}
      </strong>
      <strong className="tsl-retest">
        {t(lang, 'tm.testrailProgress.count.retest', { count: formatInteger(progress.retest, lang) })}
      </strong>
      <strong className="tsl-failed">
        {t(lang, 'tm.testrailProgress.count.failed', { count: formatInteger(progress.failed, lang) })}
      </strong>
      <strong className="tsl-untested">
        {t(lang, 'tm.testrailProgress.count.untested', { count: formatInteger(progress.untested, lang) })}
      </strong>
      <strong className="tsl-custom">
        {t(lang, 'tm.testrailProgress.count.custom', { count: formatInteger(progress.custom, lang) })}
      </strong>
      <strong className="tsl-rate">
        {t(lang, 'tm.testrailProgress.count.rate', { pct: formatNumber(pct, 0, lang) })}
      </strong>
    </span>
  );
}
