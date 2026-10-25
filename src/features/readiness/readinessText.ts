import { t, type TranslationKey } from '../../i18n';
import { readinessBadgeKey, type ReadinessReason, type ReleaseReadiness } from '../../domain/readiness';
import type { Language } from '../../types';

/** The sentence for one reason (the domain carries only a key and metadata; the words live in the locale files). */
export function readinessReasonText(lang: Language, r: ReadinessReason): string {
  let key: string = r.messageKey;
  if (r.code === 'projected_finish_late' && (r.metadata?.daysLate ?? null) === null) key = 'readiness.reason.projected_finish_late_time';
  if (r.code === 'staffing_gap' && r.severity === 'info') key = 'readiness.reason.staffing_gap_info';
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(r.metadata ?? {})) vars[k] = v === null ? '—' : typeof v === 'boolean' ? String(v) : v;
  return t(lang, key as TranslationKey, vars);
}

/** Why a policy-driven blocking reason blocks ("because your QA policy ..."), or null when the reason is not a policy decision. */
export function readinessPolicyNote(lang: Language, r: ReadinessReason): string | null {
  if (r.severity !== 'blocking') return null;
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(r.metadata ?? {})) vars[k] = v === null ? '—' : typeof v === 'boolean' ? String(v) : v;
  if (r.code === 'critical_defect_open') return t(lang, 'readiness.policy.explain.defects', vars);
  if (r.code === 'blocked_cases_open') return t(lang, 'readiness.policy.explain.blockedCases');
  if (r.code === 'test_failures_open') return t(lang, 'readiness.policy.explain.failedCases');
  return null;
}

export function readinessStateLabel(lang: Language, r: ReleaseReadiness): string {
  return t(lang, `readiness.state.${readinessBadgeKey(r)}` as TranslationKey);
}

/** Reasons of one severity, as sentences, in the domain's deterministic order. */
export function readinessReasonTexts(lang: Language, r: ReleaseReadiness, severity: ReadinessReason['severity']): string[] {
  return r.reasons.filter((x) => x.severity === severity).map((x) => readinessReasonText(lang, x));
}
