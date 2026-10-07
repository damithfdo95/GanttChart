import { useMemo, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { useConfirm } from '../../components/ConfirmDialog';
import { t, type TranslationKey } from '../../i18n';
import { REQUEST_DELETION_CONFIRMATION, type TenantDto } from '../../../shared/tenancy';
import { browserMigrationDeps } from './migrationDeps';
import { MigrateToLocal } from './MigrateToLocal';
import { MigrateToWeb } from './MigrateToWeb';
import { StorageModeExplainer } from './TeamScreen';
import { errorKey, isSessionEnded, panelCapabilities, whenText } from './format';
import { useSession } from '../../app/session-context';

type Dialog = 'to-web' | 'to-local' | null;

/**
 * Settings -> Workspace: who you are, which workspace, where its data lives.
 * Admins also get storage migration (Local to Web, Web to Local) and the deletion request; users only see
 * their own workspace and role. User management lives on the Team / Users screen. Renders nothing without a backend.
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
  const session = useSession();
  const confirm = useConfirm();

  const tenant = tenantOverride ?? principal?.tenant ?? null;
  const deps = useMemo(
    () => (api === null || tenant === null || principal === null ? null : browserMigrationDeps(api, { email: principal.email, tenantId: tenant.id })),
    [api, tenant, principal],
  );
  const caps = panelCapabilities(principal === null ? null : { role: principal.role, isOwner: principal.isOwner, tenant });
  if (!caps.showPanel || principal === null || api === null || tenant === null || deps === null) return null;

  const isAdmin = caps.canChooseStorage;
  const roleText = t(lang, `tenancy.role.${principal.role}` as TranslationKey);
  const current = { app: app.state, reports: reports.state };

  const handle = (e: unknown): void => {
    if (isSessionEnded(e)) session.endSession('expired');
    else setMessage({ kind: 'error', text: t(lang, errorKey(e)) });
  };

  const requestDeletion = async (): Promise<void> => {
    const ok = await confirm({
      title: t(lang, 'tenancy.delete.requestTitle'),
      body: (
        <>
          <p>{t(lang, 'tenancy.delete.requestScope', { name: tenant.name })}</p>
          <ul>
            {(['deleteItem1', 'deleteItem2', 'deleteItem3', 'deleteItem4', 'deleteItem5', 'deleteItem6'] as const).map((k) => (
              <li key={k}>{t(lang, `tenancy.super.${k}`)}</li>
            ))}
          </ul>
          <p>
            <strong>{t(lang, 'tenancy.delete.requestNothingYet')}</strong>
          </p>
        </>
      ),
      confirmLabel: t(lang, 'tenancy.delete.requestButton'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: 'danger',
      typed: [{ label: t(lang, 'tenancy.toWeb.typeToConfirm', { word: REQUEST_DELETION_CONFIRMATION }), expected: REQUEST_DELETION_CONFIRMATION }],
    });
    if (!ok) return;
    setBusy(true);
    setMessage(null);
    try {
      setTenantOverride(await api.requestDeletion());
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
    }
  };

  const cancelDeletion = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      setTenantOverride(await api.cancelDeletion());
    } catch (e) {
      handle(e);
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
            <StorageModeExplainer lang={lang} mode={tenant.storageMode} />
            {tenant.status === 'deletion_requested' ? (
              <p role="status">
                <span aria-hidden="true">⚠ </span>
                {t(lang, 'tenancy.panel.deletionBanner', { when: whenText(tenant.deletionRequestedAt, lang) })}
              </p>
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
        <div aria-live="polite">
          {message === null ? null : (
            <p className={`data-controls-message ${message.kind}`} role="alert">
              {message.text}
            </p>
          )}
        </div>
      </section>

      {caps.canRequestDeletion ? (
        <section className="dr-section danger-zone" aria-labelledby="tenancy-delete-title">
          <h2 id="tenancy-delete-title">{t(lang, 'tenancy.delete.title')}</h2>
          <p className="dr-summary">{t(lang, 'tenancy.delete.help')}</p>
          {tenant.status === 'deletion_requested' ? (
            <>
              <p role="status">
                <span aria-hidden="true">⚠ </span>
                <strong>{t(lang, 'tenancy.tenantStatus.deletion_requested')}</strong> — {t(lang, 'tenancy.delete.requested', { when: whenText(tenant.deletionRequestedAt, lang) })}
              </p>
              <button type="button" className="btn" disabled={busy} onClick={() => void cancelDeletion()}>
                {t(lang, 'tenancy.delete.cancel')}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void requestDeletion()}>
              {t(lang, 'tenancy.delete.request')}
            </button>
          )}
        </section>
      ) : null}
    </>
  );
}
