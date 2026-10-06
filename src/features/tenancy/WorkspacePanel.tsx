import { useMemo, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { t, type TranslationKey } from '../../i18n';
import type { TenantDto } from '../../../shared/tenancy';
import { browserMigrationDeps } from './migrationDeps';
import { MigrateToLocal } from './MigrateToLocal';
import { MigrateToWeb } from './MigrateToWeb';
import { UsersManager } from './UsersManager';
import { errorKey, panelCapabilities, whenText } from './format';

type Dialog = 'to-web' | 'to-local' | null;

/**
 * Settings → Workspace: who you are, which workspace, where its data lives.
 * Admins also get storage migration, user management and the deletion request;
 * users only see their own workspace and role. Renders nothing without a backend.
 */
export function WorkspacePanel() {
  const { principal, api } = useTenant();
  const app = useAppStateCtx();
  const reports = useReportsStateCtx();
  const lang = app.state.language;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [tenantOverride, setTenantOverride] = useState<TenantDto | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const tenant = tenantOverride ?? principal?.tenant ?? null;
  const deps = useMemo(
    () => (api === null || tenant === null || principal === null ? null : browserMigrationDeps(api, { email: principal.email, tenantId: tenant.id })),
    [api, tenant, principal],
  );
  const caps = panelCapabilities(principal === null ? null : { role: principal.role, tenant });
  if (!caps.showPanel || principal === null || api === null || tenant === null || deps === null) return null;

  const isAdmin = caps.canChooseStorage;
  const roleText = t(lang, `tenancy.role.${principal.role}` as TranslationKey);
  const current = { app: app.state, reports: reports.state };

  const deletionAction = async (action: 'request' | 'cancel'): Promise<void> => {
    if (action === 'request' && !window.confirm(t(lang, 'tenancy.delete.requestConfirm'))) return;
    setBusy(true);
    setMessage(null);
    try {
      setTenantOverride(action === 'request' ? await api.requestDeletion() : await api.cancelDeletion());
    } catch (e) {
      setMessage({ kind: 'error', text: t(lang, errorKey(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="dr-section" aria-labelledby="tenancy-panel-title">
        <h2 id="tenancy-panel-title">{t(lang, 'tenancy.panel.title')}</h2>
        <p>{t(lang, 'tenancy.panel.you', { email: principal.email, role: roleText })}</p>
        <p>
          <strong>{t(lang, 'tenancy.panel.name')}:</strong> {tenant.name} · <strong>{t(lang, 'tenancy.panel.id')}:</strong> <code>{tenant.id}</code>
        </p>
        {isAdmin ? (
          <>
            <p>
              <strong>{t(lang, 'tenancy.panel.storage')}:</strong> {t(lang, `tenancy.mode.${tenant.storageMode}` as TranslationKey)}
            </p>
            <p className="dr-summary">{t(lang, tenant.storageMode === 'web' ? 'tenancy.panel.webHelp' : 'tenancy.panel.localHelp')}</p>
            {tenant.status === 'deletion_requested' ? (
              <p role="status">{t(lang, 'tenancy.panel.deletionBanner', { when: whenText(tenant.deletionRequestedAt, lang) })}</p>
            ) : null}
            <div className="dr-button-row">
              {tenant.storageMode === 'local' ? (
                <button type="button" className="btn" disabled={dialog !== null} onClick={() => setDialog('to-web')}>
                  {t(lang, 'tenancy.panel.toWeb')}
                </button>
              ) : (
                <button type="button" className="btn" disabled={dialog !== null} onClick={() => setDialog('to-local')}>
                  {t(lang, 'tenancy.panel.toLocal')}
                </button>
              )}
            </div>
            {dialog === 'to-web' ? <MigrateToWeb lang={lang} local={current} deps={deps} onClose={() => setDialog(null)} /> : null}
            {dialog === 'to-local' ? <MigrateToLocal lang={lang} current={current} deps={deps} onClose={() => setDialog(null)} /> : null}
          </>
        ) : (
          <p className="dr-summary">
            {t(lang, 'tenancy.user.body', {
              name: tenant.name,
              role: roleText,
              access: t(lang, `tenancy.access.${principal.access ?? 'viewer'}` as TranslationKey),
            })}
          </p>
        )}
        {message === null ? null : (
          <p className={`data-controls-message ${message.kind}`} role="alert">
            {message.text}
          </p>
        )}
      </section>

      {caps.canManageUsers ? <UsersManager lang={lang} api={api} /> : null}
      {isAdmin && !caps.canManageUsers ? (
        <section className="dr-section">
          <h2>{t(lang, 'tenancy.users.title')}</h2>
          <p className="dr-summary">{t(lang, 'tenancy.users.localOnly')}</p>
        </section>
      ) : null}

      {caps.canRequestDeletion ? (
        <section className="dr-section danger-zone" aria-labelledby="tenancy-delete-title">
          <h2 id="tenancy-delete-title">{t(lang, 'tenancy.delete.title')}</h2>
          <p className="dr-summary">{t(lang, 'tenancy.delete.help')}</p>
          {tenant.status === 'deletion_requested' ? (
            <>
              <p role="status">{t(lang, 'tenancy.delete.requested', { when: whenText(tenant.deletionRequestedAt, lang) })}</p>
              <button type="button" className="btn" disabled={busy} onClick={() => void deletionAction('cancel')}>
                {t(lang, 'tenancy.delete.cancel')}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void deletionAction('request')}>
              {t(lang, 'tenancy.delete.request')}
            </button>
          )}
        </section>
      ) : null}
    </>
  );
}
