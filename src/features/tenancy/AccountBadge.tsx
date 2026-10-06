import { t, type TranslationKey } from '../../i18n';
import type { PrincipalDto } from '../../../shared/tenancy';
import type { Language } from '../../types';

/**
 * Who is signed in and where, in the header: name (or email), role in words, workspace and storage mode.
 * Internal ids are never shown here.
 */
export function AccountBadge({ lang, principal }: { lang: Language; principal: PrincipalDto }) {
  const role = t(lang, `tenancy.role.${principal.role}` as TranslationKey);
  const name = principal.displayName ?? principal.email;
  const tenant = principal.tenant;
  return (
    <span className="account-badge" title={principal.email}>
      <span className="account-name">
        <strong>{name}</strong>
        {principal.displayName === null ? null : <span className="account-email">{principal.email}</span>}
      </span>
      <span className={`role-chip role-${principal.role}`}>{role}</span>
      {tenant === null ? null : (
        <span className="account-workspace">
          {tenant.name} · {t(lang, `tenancy.modeShort.${tenant.storageMode}` as TranslationKey)}
        </span>
      )}
    </span>
  );
}
