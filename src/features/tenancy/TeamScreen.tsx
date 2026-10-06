import { useCallback } from 'react';
import { useTenant } from '../../app/tenant-context';
import { useAppStateCtx } from '../../app/state-contexts';
import { t } from '../../i18n';
import type { PrincipalDto, StorageMode } from '../../../shared/tenancy';
import type { TenancyApi } from '../../lib/tenancy/api';
import type { Language } from '../../types';
import { AuditLog } from './AuditLog';
import { UsersManager } from './UsersManager';

/** What each storage mode means, in plain words. Used wherever a person decides or wonders. */
export function StorageModeExplainer({ lang, mode }: { lang: Language; mode: StorageMode }) {
  const items = mode === 'web' ? (['web1', 'web2', 'web3', 'web4'] as const) : (['local1', 'local2', 'local3', 'local4'] as const);
  return (
    <div className="storage-explainer" role="note">
      <strong>{t(lang, mode === 'web' ? 'tenancy.storage.webTitle' : 'tenancy.storage.localTitle')}</strong>
      <ul>
        {items.map((k) => (
          <li key={k}>{t(lang, `tenancy.storage.${k}`)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Team / Users" for the Admin. In Web storage it manages Users and shows this workspace's administrative history.
 * In Local storage it explains why there is nothing to manage here, instead of showing a dead button.
 */
export function TeamScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { principal, api } = useTenant();
  const { state } = useAppStateCtx();
  if (principal === null || api === null) return null;
  return <TeamView lang={state.language} principal={principal} api={api} onOpenSettings={onOpenSettings} />;
}

/** The screen itself, independent of app state so it can be rendered and tested on its own. */
export function TeamView({ lang, principal, api, onOpenSettings }: { lang: Language; principal: PrincipalDto; api: TenancyApi; onOpenSettings: () => void }) {
  const loadAudit = useCallback(() => api.tenantAudit(), [api]);
  if (principal.tenant === null || principal.role !== 'admin') return null;
  const tenant = principal.tenant;

  return (
    <div className="team-screen">
      <header className="dr-section">
        <h1>{t(lang, 'team.title')}</h1>
        <p>
          <strong>{tenant.name}</strong> · {t(lang, tenant.storageMode === 'web' ? 'tenancy.mode.web' : 'tenancy.mode.local')}
        </p>
      </header>
      {tenant.storageMode === 'web' ? (
        <>
          <UsersManager lang={lang} api={api} />
          <AuditLog lang={lang} load={loadAudit} title={t(lang, 'tenancy.audit.workspaceTitle')} emptyKey="tenancy.audit.empty" />
        </>
      ) : (
        <>
          <section className="dr-section tenancy-empty" aria-labelledby="team-local-title">
            <h2 id="team-local-title">{t(lang, 'tenancy.users.title')}</h2>
            <p role="status">
              <strong>{t(lang, 'tenancy.users.localOnly')}</strong>
            </p>
            <StorageModeExplainer lang={lang} mode="local" />
            <StorageModeExplainer lang={lang} mode="web" />
            <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
              {t(lang, 'team.openStorageSettings')}
            </button>
          </section>
          <AuditLog lang={lang} load={loadAudit} title={t(lang, 'tenancy.audit.workspaceTitle')} emptyKey="tenancy.audit.empty" />
        </>
      )}
    </div>
  );
}
