import { t, type TranslationKey } from '../../i18n';
import type { Language } from '../../types';

/**
 * The account list of Team Members now lives in TeamDirectory (Stage 8D: profiles and logins in one table). What stays here is the small
 * shared piece several screens use.
 */

/** Status in words and a symbol — never colour alone. */
export function StatusBadge({ lang, status }: { lang: Language; status: 'active' | 'disabled' | 'deactivated' | 'deletion_requested' | 'deleting' }) {
  const key = status === 'deactivated' ? 'disabled' : status;
  const symbol = key === 'active' ? '●' : key === 'disabled' ? '⏸' : key === 'deletion_requested' ? '⚠' : '⛔';
  const label = key === 'active' || key === 'disabled' ? `tenancy.userStatus.${key}` : `tenancy.tenantStatus.${key}`;
  return (
    <span className={`status-badge status-${key}`}>
      <span aria-hidden="true">{symbol} </span>
      {t(lang, label as TranslationKey)}
    </span>
  );
}
